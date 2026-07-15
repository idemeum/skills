/**
 * mcp/skills/findDuplicateFiles.ts — find_duplicate_files skill
 *
 * Finds duplicate files by comparing MD5 hashes. Scans a directory
 * recursively and groups files with identical content. Use when freeing
 * disk space by removing redundant copies.
 *
 * Platform strategy
 * -----------------
 * Both   Pure Node.js crypto.createHash('md5') with fs.createReadStream —
 *        cross-platform, no child_process needed.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/findDuplicateFiles.ts
 */

import * as fs       from "fs";
import * as fsp      from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import * as crypto   from "crypto";
import { z }         from "zod";

import { expandTilde } from "./_shared/expandTilde";
import { Semaphore }   from "./_shared/semaphore";

const _statSem    = process.platform === "win32" ? new Semaphore(32) : null;
// Same rationale as getLargeFiles: readdir fan-out is unbounded without this,
// causing libuv thread pool saturation + Defender/OneDrive overhead on Windows.
const _readdirSem = process.platform === "win32" ? new Semaphore(16) : null;

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "find_duplicate_files",
  description:
    "Finds duplicate files by comparing MD5 hashes. Scans a directory " +
    "recursively and groups files with identical content. " +
    "Use when freeing disk space by removing redundant copies.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  // Walks the entire home directory and MD5-hashes size-collision candidates;
  // the default 60 s ceiling isn't enough on populated homes. Tool honours
  // ctx.deadlineMs internally and returns partial results before this
  // hard timeout fires.
  timeoutMs:       180_000,
  outputKeys: ["scannedPath","scannedFiles","topDeletables","partial","warning","duplicateGroups","totalWastedBytes"],
  schema: {
    path: z
      .string()
      .nullable().optional()
      .describe("Directory to scan. Omit to scan home directory. Do NOT construct or guess a path."),
    minSizeMb: z
      .number()
      .nullable().optional()
      .describe("Minimum file size in MB to consider. Default: 5"),
    extensions: z
      .array(z.string())
      .nullable().optional()
      .describe("File extensions to check e.g. ['.jpg','.pdf']. Omit for all files"),
    topDeletableLimit: z
      .number()
      .int()
      .positive()
      .nullable().optional()
      .describe(
        "When set, the tool returns ONLY a pre-computed `topDeletables: " +
        "[{path, sizeBytes}]` array of the N largest deletable duplicate " +
        "files (one keeper per group is preserved; the rest are deletable, " +
        "ranked by per-file size descending). `duplicateGroups` and " +
        "`totalWastedBytes` are omitted to prevent downstream substitution " +
        "from accidentally surfacing scan-wide aggregates as if they were " +
        "the actionable slice. Use this when the caller wants a bounded " +
        "view ready to feed into delete_files (e.g. disk-cleanup's 5-cap).",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface DuplicateFile {
  path: string;
  name: string;
}

interface DuplicateGroup {
  hash:    string;
  sizeMb:  number;
  files:   DuplicateFile[];
}

// -- Constants ----------------------------------------------------------------

const MAX_DEPTH = 10;

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".npm", ".yarn", ".cache",
  "__pycache__", ".venv", "venv",
  // Trash directories are excluded explicitly so dupes in the Trash don't
  // double-count against the dedicated "trash" cleanup category — see the
  // matching comment in getLargeFiles.ts SKIP_DIRS.
  ".Trash", ".Trashes",                  // macOS trash (user + per-volume)
  "$Recycle.Bin", "System Volume Information",
  // macOS app sandbox roots — not user-meaningful "duplicates", and they
  // dominate ~/Library walk time. Same set used by the cache scanners.
  "Containers", "Group Containers", "Caches",
  // Windows-only: Store/UWP app sandboxes (Packages) contain cross-app
  // duplicate components (Edge WebView, etc.) that must not be deleted, and
  // DirectX shader cache (D3DSCache) is system-generated noise. Skipping
  // both cuts walk time significantly on Windows home directories.
  ...(process.platform === "win32" ? ["Packages", "D3DSCache"] : []),
]);

// On Windows HDDs, 16 concurrent readers cause disk-head thrashing — each
// reader forces random seeks across 16 different file positions, serialising
// effective I/O through a single disk arm. 4 concurrent readers keeps the
// drive busy without excessive seek contention. macOS SSD machines are fine
// at 16, so the cap is Windows-only.
const HASH_CONCURRENCY = process.platform === "win32" ? 4 : 16;

// Reading the first 64 KB eliminates most false size-collisions (two different
// files that happen to share a byte-count) before committing to a full read.
// On Windows with Defender overhead this is a significant throughput win since
// most size-collision pairs differ well within the first 64 KB.
const PARTIAL_HASH_BYTES = 64 * 1024;

// -- Helpers ------------------------------------------------------------------

function hashFile(filePath: string, end?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("md5");
    const stream = end !== undefined
      ? fs.createReadStream(filePath, { end })
      : fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end",  () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

interface WalkStats {
  dirsVisited:          number;
  dirsPermissionDenied: number;
  /** Set true when the walk aborted because the wall-clock deadline elapsed. */
  deadlineHit:          boolean;
}

/** True if a Node fs error looks like a TCC / OS permission denial. */
function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPERM" || code === "EACCES";
}

async function walk(
  dir:        string,
  minBytes:   number,
  extensions: Set<string> | null,
  acc:        { path: string; size: number }[],
  depth:      number,
  stats:      WalkStats,
  deadlineMs: number,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  if (Date.now() >= deadlineMs) { stats.deadlineHit = true; return; }
  stats.dirsVisited++;

  if (_readdirSem) await _readdirSem.acquire();
  let entries: import("fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Track TCC / permission denials separately so the run() result can
    // surface a partial-coverage warning. Other errors (ENOENT, EBUSY)
    // are still ignored silently — they're not actionable.
    if (isPermissionError(err)) stats.dirsPermissionDenied++;
    return;
  } finally {
    _readdirSem?.release();
  }

  await Promise.allSettled(
    entries.map(async (e) => {
      if (stats.deadlineHit) return;
      if (e.name.startsWith(".") && depth > 0) return;
      const full = nodePath.join(dir, e.name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) return;
        await walk(full, minBytes, extensions, acc, depth + 1, stats, deadlineMs);
      } else if (e.isFile()) {
        if (extensions && !extensions.has(nodePath.extname(e.name).toLowerCase())) return;
        if (_statSem) await _statSem.acquire();
        try {
          const stat = await fsp.stat(full);
          if (stat.size >= minBytes) {
            acc.push({ path: full, size: stat.size });
          }
        } catch {
          // skip inaccessible files
        } finally { _statSem?.release(); }
      }
    }),
  );
}

// -- Exported run function ----------------------------------------------------

interface RunCtx { deadlineMs?: number }

export async function run(
  {
    path: inputPath,
    minSizeMb  = 5,
    extensions,
    topDeletableLimit,
  }: {
    path?:              string;
    minSizeMb?:         number;
    extensions?:        string[];
    topDeletableLimit?: number;
  } = {},
  ctx?: RunCtx,
) {
  const home = os.homedir();

  // Expand ~ / ~/ before resolve() — see _shared/expandTilde.ts.
  let scanPath = nodePath.resolve(expandTilde(inputPath || home) ?? home);

  // Security: restrict scan to within home directory
  const rel = nodePath.relative(home, scanPath);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    const homeRel = nodePath.relative(scanPath, home);
    if (!homeRel.startsWith("..") && !nodePath.isAbsolute(homeRel)) {
      scanPath = home;
    } else {
      throw new Error(
        `[find_duplicate_files] Path must be within home directory (${home}): ${scanPath}`,
      );
    }
  }

  try {
    await fsp.access(scanPath);
  } catch {
    throw new Error(`[find_duplicate_files] Path not accessible: ${scanPath}`);
  }

  // SI/decimal MB (1 MB = 10^6 bytes) to match formatBytes output and
  // Finder's display.  See mcp/skills/_shared/formatBytes.ts.
  const minBytes = Math.max(0, minSizeMb * 1_000_000);
  const extSet   = extensions && extensions.length > 0
    ? new Set(extensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()))
    : null;

  // Internal deadline = 90% of the G4 ceiling. Headroom lets us serialize
  // and return partial results before the Promise.race rejects.
  const ceilingMs    = ctx?.deadlineMs ?? (Date.now() + 60_000);
  const remainingMs  = Math.max(0, ceilingMs - Date.now());
  const internalDeadlineMs = Date.now() + Math.floor(remainingMs * 0.9);

  const files: { path: string; size: number }[] = [];
  const walkStats: WalkStats = { dirsVisited: 0, dirsPermissionDenied: 0, deadlineHit: false };
  await walk(scanPath, minBytes, extSet, files, 0, walkStats, internalDeadlineMs);

  // Stage 1 — group by size (O(n), no I/O)
  const bySize = new Map<number, typeof files>();
  for (const f of files) {
    const group = bySize.get(f.size) ?? [];
    group.push(f);
    bySize.set(f.size, group);
  }
  const sizeCollisions = [...bySize.values()].filter((g) => g.length > 1).flat();

  // Stage 2 — partial hash (first 64 KB) to eliminate false size-collisions
  // before committing to a full-file read. Two different files rarely share
  // both a byte-count AND the same opening 64 KB, so this stage eliminates
  // the vast majority of candidates cheaply — especially valuable on Windows
  // where each full-read has Defender scan overhead.
  let hashDeadlineHit = false;

  async function runHashWorkers(
    pool: typeof files,
    hashFn: (path: string) => Promise<string>,
  ): Promise<Map<string, typeof files>> {
    const result = new Map<string, typeof files>();
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const worker = async () => {
      while (cursor < pool.length) {
        if (Date.now() >= internalDeadlineMs) { hashDeadlineHit = true; return; }
        const f = pool[cursor++];
        try {
          const h     = await hashFn(f.path);
          const group = result.get(h) ?? [];
          group.push(f);
          result.set(h, group);
        } catch { /* skip unreadable */ }
      }
    };
    for (let i = 0; i < HASH_CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    return result;
  }

  const byPartial   = await runHashWorkers(
    sizeCollisions,
    (p) => hashFile(p, PARTIAL_HASH_BYTES - 1),
  );
  // Only full-hash files that still collide after the partial check
  const fullCandidates = [...byPartial.values()].filter((g) => g.length > 1).flat();

  const byHash = await runHashWorkers(fullCandidates, (p) => hashFile(p));

  // Build duplicate groups (2+ files with same hash)
  const duplicateGroups: DuplicateGroup[] = [];
  let totalWastedBytes = 0;

  for (const [hash, group] of byHash.entries()) {
    if (group.length < 2) continue;
    // SI/decimal MB to match formatBytes + Finder.
    const sizeMb = Math.round((group[0].size / 1_000_000) * 100) / 100;
    // Wasted space = (n-1) copies * size
    totalWastedBytes += (group.length - 1) * group[0].size;
    duplicateGroups.push({
      hash,
      sizeMb,
      files: group.map((f) => ({ path: f.path, name: nodePath.basename(f.path) })),
    });
  }

  // Sort by most wasted space first
  duplicateGroups.sort((a, b) => {
    const wastedA = (a.files.length - 1) * a.sizeMb;
    const wastedB = (b.files.length - 1) * b.sizeMb;
    return wastedB - wastedA;
  });

  // ── Partial-result detection ────────────────────────────────────────────────
  // Same logic as get_large_files: when the walk skipped a meaningful share
  // of directories due to OS permission errors, the duplicate set is
  // necessarily incomplete. Surface so the user knows there may be more
  // duplicates in unscanned subtrees.
  let warning: string | undefined;
  if (walkStats.deadlineHit || hashDeadlineHit) {
    warning =
      "Duplicate scan stopped at the per-tool deadline. Results cover only the " +
      "files scanned so far — there may be more duplicates in untraversed subtrees.";
  } else if (
    walkStats.dirsVisited > 0 &&
    walkStats.dirsPermissionDenied / walkStats.dirsVisited > 0.2
  ) {
    warning =
      `Duplicate scan is incomplete: ${walkStats.dirsPermissionDenied} of ` +
      `${walkStats.dirsVisited} directories could not be read (likely missing ` +
      `Full Disk Access). Open System Settings → Privacy & Security → ` +
      `Full Disk Access, enable AI Support Agent, then quit and relaunch.`;
  }

  // When the caller asked for a bounded actionable slice (topDeletableLimit),
  // return ONLY the pre-computed top-N deletables and omit `duplicateGroups`
  // and `totalWastedBytes`. The aggregates would mislead downstream
  // substitution into showing scan-wide counts instead of the actionable
  // top-N (e.g. cleanup-card showing "100 groups (2.9 GB)" when only 5
  // files will actually be deleted). Symmetric to get_large_files's `limit`
  // contract.
  if (topDeletableLimit !== undefined) {
    // Pool deletables across all groups: skip files[0] (the keeper) from
    // each group, tag each remaining file with its group's per-file size.
    // All files in a duplicate group are byte-identical, so per-file size
    // equals the group's size.
    const pool: { path: string; sizeBytes: number }[] = [];
    for (const group of duplicateGroups) {
      const sizeBytes = Math.round(group.sizeMb * 1_000_000);
      for (let i = 1; i < group.files.length; i++) {
        pool.push({ path: group.files[i].path, sizeBytes });
      }
    }
    pool.sort((a, b) => b.sizeBytes - a.sizeBytes);
    const topDeletables = pool.slice(0, topDeletableLimit);

    return {
      scannedPath:   scanPath,
      scannedFiles:  files.length,
      topDeletables,
      partial:       walkStats.deadlineHit || hashDeadlineHit,
      ...(warning ? { warning } : {}),
    };
  }

  return {
    scannedPath:     scanPath,
    scannedFiles:    files.length,
    duplicateGroups,
    // Aggregate in bytes for uniformity with other disk-cleanup tools
    // (get_app_cache_info, get_browser_cache_info, get_trash_info, etc.) and
    // for the disk-cleanup SKILL.md > Data lineage present_preview summary.
    totalWastedBytes,
    partial:         walkStats.deadlineHit || hashDeadlineHit,
    ...(warning ? { warning } : {}),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
