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
  schema: {
    path: z
      .string()
      .optional()
      .describe("Directory to scan. Defaults to home directory"),
    minSizeMb: z
      .number()
      .optional()
      .describe("Minimum file size in MB to consider. Default: 1"),
    extensions: z
      .array(z.string())
      .optional()
      .describe("File extensions to check e.g. ['.jpg','.pdf']. Omit for all files"),
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
  "$Recycle.Bin", "System Volume Information",
]);

// -- Helpers ------------------------------------------------------------------

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash   = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end",  () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

interface WalkStats {
  dirsVisited:          number;
  dirsPermissionDenied: number;
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
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  stats.dirsVisited++;

  let entries: import("fs").Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Track TCC / permission denials separately so the run() result can
    // surface a partial-coverage warning. Other errors (ENOENT, EBUSY)
    // are still ignored silently — they're not actionable.
    if (isPermissionError(err)) stats.dirsPermissionDenied++;
    return;
  }

  await Promise.allSettled(
    entries.map(async (e) => {
      if (e.name.startsWith(".") && depth > 0) return;
      const full = nodePath.join(dir, e.name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) return;
        await walk(full, minBytes, extensions, acc, depth + 1, stats);
      } else if (e.isFile()) {
        if (extensions && !extensions.has(nodePath.extname(e.name).toLowerCase())) return;
        try {
          const stat = await fsp.stat(full);
          if (stat.size >= minBytes) {
            acc.push({ path: full, size: stat.size });
          }
        } catch {
          // skip inaccessible files
        }
      }
    }),
  );
}

// -- Exported run function ----------------------------------------------------

export async function run({
  path: inputPath,
  minSizeMb  = 1,
  extensions,
}: {
  path?:       string;
  minSizeMb?:  number;
  extensions?: string[];
} = {}) {
  const home     = os.homedir();
  const scanPath = nodePath.resolve(inputPath ?? home);

  // Security: restrict scan to within home directory
  const rel = nodePath.relative(home, scanPath);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(
      `[find_duplicate_files] Path must be within home directory (${home}): ${scanPath}`,
    );
  }

  try {
    await fsp.access(scanPath);
  } catch {
    throw new Error(`[find_duplicate_files] Path not accessible: ${scanPath}`);
  }

  const minBytes   = Math.max(0, minSizeMb * 1024 * 1024);
  const extSet     = extensions && extensions.length > 0
    ? new Set(extensions.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase()))
    : null;

  const files: { path: string; size: number }[] = [];
  const walkStats: WalkStats = { dirsVisited: 0, dirsPermissionDenied: 0 };
  await walk(scanPath, minBytes, extSet, files, 0, walkStats);

  // Group by size first (cheap pre-filter before hashing)
  const bySize = new Map<number, typeof files>();
  for (const f of files) {
    const group = bySize.get(f.size) ?? [];
    group.push(f);
    bySize.set(f.size, group);
  }

  // Only hash files that share a size with at least one other file
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();

  // Hash candidates and group by hash
  const byHash = new Map<string, typeof files>();
  await Promise.allSettled(
    candidates.map(async (f) => {
      try {
        const h     = await hashFile(f.path);
        const group = byHash.get(h) ?? [];
        group.push(f);
        byHash.set(h, group);
      } catch {
        // skip unreadable files
      }
    }),
  );

  // Build duplicate groups (2+ files with same hash)
  const duplicateGroups: DuplicateGroup[] = [];
  let totalWastedBytes = 0;

  for (const [hash, group] of byHash.entries()) {
    if (group.length < 2) continue;
    const sizeMb = Math.round((group[0].size / (1024 * 1024)) * 100) / 100;
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

  const totalWastedMb = Math.round((totalWastedBytes / (1024 * 1024)) * 100) / 100;

  // ── Partial-result detection ────────────────────────────────────────────────
  // Same logic as get_large_files: when the walk skipped a meaningful share
  // of directories due to OS permission errors, the duplicate set is
  // necessarily incomplete. Surface so the user knows there may be more
  // duplicates in unscanned subtrees.
  let warning: string | undefined;
  if (
    walkStats.dirsVisited > 0 &&
    walkStats.dirsPermissionDenied / walkStats.dirsVisited > 0.2
  ) {
    warning =
      `Duplicate scan is incomplete: ${walkStats.dirsPermissionDenied} of ` +
      `${walkStats.dirsVisited} directories could not be read (likely missing ` +
      `Full Disk Access). Open System Settings → Privacy & Security → ` +
      `Full Disk Access, enable AI Support Agent, then quit and relaunch.`;
  }

  return {
    scannedPath:     scanPath,
    scannedFiles:    files.length,
    duplicateGroups,
    totalWastedMb,
    ...(warning ? { warning } : {}),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
