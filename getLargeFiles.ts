/**
 * mcp/skills/getLargeFiles.ts — get_large_files skill
 *
 * Recursively walks a directory and returns files whose size exceeds a
 * threshold, sorted largest first.  Complements disk_scan by identifying
 * specific files (not just folders) that are consuming space.
 *
 * Platform strategy
 * -----------------
 * Both   Pure Node.js fs.readdir + fs.stat — cross-platform, no shell needed.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getLargeFiles.ts [/path] [minMB] [limit]
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { z }         from "zod";

import { expandTilde } from "./_shared/expandTilde";
import { formatBytes } from "./_shared/formatBytes";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_large_files",
  description:
    "Recursively scans a directory and returns files whose size exceeds the " +
    "given threshold, sorted largest first. " +
    "Use to identify specific files consuming disk space after disk_scan " +
    "has narrowed down the target directory.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    path: z
      .string()
      .optional()
      .describe(
        "Absolute path of the directory to scan recursively. " +
        "Defaults to the user home directory.",
      ),
    minSizeBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Only return files at least this large in bytes. Default: 104857600 (100 MB)."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of files to return. Default: 20."),
  },
} as const;

// -- Constants ----------------------------------------------------------------

const DEFAULT_MIN_BYTES = 100 * 1_000_000; // 100 MB (decimal/SI; matches formatBytes + Finder)
const DEFAULT_LIMIT     = 20;
const MAX_DEPTH         = 12; // prevent stack overflow on deep trees

// Directories unlikely to contain user-owned deletable files.
// Trash directories are excluded explicitly: get_trash_info handles them
// (disk-cleanup Step 8) and empty_trash is the destructive surface
// (disk-cleanup Step 11).  Without this exclusion, large items in the
// Trash double-count under both the "large-files" and "trash" categories
// on the cleanup card, and a "large-files" deletion would race against
// the user's "trash" empty.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".npm", ".yarn", ".cache",
  "Library", "__pycache__", ".venv", "venv",
  ".Trash", ".Trashes",                      // macOS trash (user + per-volume)
  "$Recycle.Bin", "System Volume Information", "Windows",
  "Program Files", "Program Files (x86)",
]);

// formatBytes is imported from _shared/formatBytes.

interface FileEntry {
  path:      string;
  size:      number;
  sizeHuman: string;
  modified:  string; // ISO 8601
}

// -- Recursive walker ---------------------------------------------------------

interface WalkStats {
  dirsVisited:        number;
  dirsPermissionDenied: number;
}

/** True if a Node fs error looks like a TCC / OS permission denial. */
function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPERM" || code === "EACCES";
}

async function walk(
  dir:     string,
  minSize: number,
  acc:     FileEntry[],
  depth:   number,
  stats:   WalkStats,
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  stats.dirsVisited++;

  let entries: import("fs").Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    // Track permission denials separately so the run() result can flag
    // partial coverage. Non-permission errors (ENOENT, EBUSY, etc.) are
    // ignored silently as before.
    if (isPermissionError(err)) stats.dirsPermissionDenied++;
    return;
  }

  await Promise.allSettled(
    entries.map(async (e) => {
      // Skip hidden entries at non-root depth (e.g. .git, .DS_Store)
      if (e.name.startsWith(".") && depth > 0) return;

      const full = nodePath.join(dir, e.name);

      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) return;
        await walk(full, minSize, acc, depth + 1, stats);
      } else if (e.isFile()) {
        try {
          const stat = await fs.stat(full);
          if (stat.size >= minSize) {
            acc.push({
              path:      full,
              size:      stat.size,
              sizeHuman: formatBytes(stat.size),
              modified:  stat.mtime.toISOString(),
            });
          }
        } catch { /* unreadable file — skip */ }
      }
    }),
  );
}

// -- Exported run function ----------------------------------------------------

export async function run({
  path: inputPath   = os.homedir(),
  minSizeBytes      = DEFAULT_MIN_BYTES,
  limit,
}: {
  path?:         string;
  minSizeBytes?: number;
  limit?:        number;
} = {}) {
  // Caller-set vs default-applied distinction matters for the output shape:
  // when the caller explicitly passes `limit`, they're asking for a bounded
  // slice and the executor LLM downstream should NOT see aggregate fields
  // (totalFound, totalBytes) that span the full match set — those mislead
  // the cleanup-card substitution into showing "50 files" when only 5 are
  // actionable. With no explicit limit, callers get the aggregates as
  // before for back-compat with diagnostic-only consumers.
  const limitWasSet  = limit !== undefined;
  const effectiveLimit = limit ?? DEFAULT_LIMIT;

  // Expand ~ / ~/ — nodePath.resolve treats "~" as a literal segment
  // relative to cwd, producing a non-existent path the executor LLM has
  // to spot and retry around.  See mcp/skills/_shared/expandTilde.ts.
  const scanPath = nodePath.resolve(expandTilde(inputPath) ?? inputPath);

  // Security: restrict scanning to within the user home directory.
  // Prevents Claude from being directed to scan /etc, /var, or other
  // system paths that could leak sensitive file names to the LLM context.
  //
  // Symlink defence: resolve the real path BEFORE checking against home.
  // Without this a symlink inside ~/  pointing to /etc would bypass the
  // relative-path check — nodePath.relative would see it as a child of home
  // but fs.readdir would walk the symlink target.
  let realScanPath: string;
  try {
    realScanPath = await fs.realpath(scanPath);
  } catch {
    throw new Error(`[get_large_files] Path not accessible: ${scanPath}`);
  }

  const home     = os.homedir();
  // Also resolve home so that macOS /var/folders symlinks are handled correctly
  // (on macOS os.homedir() can return /Users/x while realpath gives the same).
  const realHome = await fs.realpath(home).catch(() => home);

  const rel = nodePath.relative(realHome, realScanPath);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(
      `[get_large_files] Path must be within home directory`,
    );
  }

  const results: FileEntry[] = [];
  const stats: WalkStats     = { dirsVisited: 0, dirsPermissionDenied: 0 };
  await walk(realScanPath, minSizeBytes, results, 0, stats);
  results.sort((a, b) => b.size - a.size);

  const files = results.slice(0, effectiveLimit);

  // ── Partial-result detection ────────────────────────────────────────────────
  // If a meaningful share of directories couldn't be read because of OS
  // permission errors, the file list is incomplete and the user shouldn't
  // trust it for cleanup decisions. Almost always a TCC denial — the agent
  // doesn't have Full Disk Access and can't traverse into protected
  // subtrees (~/Library, etc.).
  let warning: string | undefined;
  if (
    stats.dirsVisited > 0 &&
    stats.dirsPermissionDenied / stats.dirsVisited > 0.2
  ) {
    warning =
      `Scan results are incomplete: ${stats.dirsPermissionDenied} of ` +
      `${stats.dirsVisited} directories could not be read (likely missing ` +
      `Full Disk Access). Open System Settings → Privacy & Security → ` +
      `Full Disk Access, enable AI Support Agent, then quit and relaunch.`;
  }

  return {
    scannedPath:  scanPath,
    minSizeBytes,
    minSizeHuman: formatBytes(minSizeBytes),
    returned:     files.length,
    files,
    // Aggregates spanning the full match set (not the returned slice) are
    // only included when the caller did NOT specify `limit`. With limit set,
    // the caller already declared they want a bounded view; surfacing the
    // wider counts misleads downstream substitution. See the run() header
    // comment for the rationale.
    ...(limitWasSet ? {} : {
      totalFound: results.length,
      totalBytes: results.reduce((s, f) => s + f.size, 0),
    }),
    ...(warning ? { warning } : {}),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  const scanPath    = process.argv[2] ?? os.homedir();
  const minMB       = parseInt(process.argv[3] ?? "100", 10);
  const limit       = parseInt(process.argv[4] ?? "20", 10);
  const minSizeBytes = minMB * 1024 * 1024;

  console.log(`\nScanning ${scanPath} for files >= ${minMB} MB (limit ${limit})...\n`);

  run({ path: scanPath, minSizeBytes, limit })
    .then((r) => {
      console.log(`Returned ${r.returned} file(s) >= ${r.minSizeHuman}\n`);
      r.files.forEach((f) =>
        console.log(`  ${f.sizeHuman.padStart(10)}  ${f.path}`),
      );
    })
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
