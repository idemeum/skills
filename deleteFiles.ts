/**
 * mcp/skills/deleteFiles.ts — delete_files skill
 *
 * Permanently removes files and directories.
 * Safety guards prevent deletion outside the user home directory and block
 * known OS-critical paths.  A dryRun mode lets Claude report impact first.
 *
 * IMPORTANT: Always obtain explicit user confirmation before calling this.
 *
 * Platform strategy
 * -----------------
 * Both   fs.rm({ recursive, force }) — cross-platform Node.js
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/deleteFiles.ts
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { z }         from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "delete_files",
  description:
    "Permanently deletes the specified files or directories. " +
    "ALWAYS obtain explicit user confirmation before calling. " +
    "Restricted to paths within the user home directory. " +
    "Use dryRun:true first to show the user what will be removed.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    paths: z
      .array(z.string().min(1))
      .min(1)
      .describe("Absolute paths of files or directories to delete."),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "When true, reports what would be deleted without actually deleting. " +
        "Default: false.",
      ),
  },
} as const;

// -- Safety -------------------------------------------------------------------

const BLOCKED_DARWIN = new Set([
  "/", "/usr", "/bin", "/sbin", "/etc", "/var",
  "/System", "/Library", "/Applications", "/private", "/private/etc",
]);

const BLOCKED_WIN32 = [
  "C:\\Windows",
  "C:\\Program Files",
  "C:\\Program Files (x86)",
  "C:\\ProgramData",
  "C:\\System Volume Information",
];

function assertSafe(target: string): void {
  if (!nodePath.isAbsolute(target)) {
    throw new Error(`Not an absolute path: ${target}`);
  }

  const platform = os.platform();
  const home     = os.homedir();

  // Must be inside home directory
  const rel = nodePath.relative(home, target);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(
      `Path is outside home directory (${home}): ${target}. ` +
      "delete_files only operates within the home directory.",
    );
  }

  // Must not BE the home directory itself
  if (rel === "") {
    throw new Error(`Refusing to delete home directory itself: ${target}`);
  }

  // Must not be a known OS-critical path
  if (platform === "win32") {
    for (const blocked of BLOCKED_WIN32) {
      if (target.toLowerCase().startsWith(blocked.toLowerCase())) {
        throw new Error(`Refusing to delete system path: ${target}`);
      }
    }
  } else {
    if (BLOCKED_DARWIN.has(target)) {
      throw new Error(`Refusing to delete system path: ${target}`);
    }
  }
}

// -- Helpers ------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

/** Recursively calculate the size of a directory or return file size. */
async function treeSize(target: string): Promise<number> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;

  const children = await fs.readdir(target).catch(() => [] as string[]);
  const sizes    = await Promise.all(
    children.map((c) => treeSize(nodePath.join(target, c))),
  );
  return sizes.reduce((a, b) => a + b, 0);
}

// -- Exported run function ----------------------------------------------------

export async function run({
  paths,
  dryRun = false,
}: {
  paths:   string[];
  dryRun?: boolean;
}) {
  const items = await Promise.all(
    paths.map(async (p) => {
      const target = nodePath.resolve(p);

      // Safety check first
      try {
        assertSafe(target);
      } catch (err) {
        return {
          path:    target,
          success: false,
          error:   (err as Error).message,
        };
      }

      // Verify existence and guard against symlink-swap TOCTOU attacks.
      // Using lstat (not stat) so we inspect the link itself, not its target.
      // Refusing symlinks prevents an attacker from swapping a safe path for
      // a symlink pointing at a critical file between our safety check and
      // the actual fs.rm() call.
      let entryStat: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        entryStat = await fs.lstat(target);
      } catch {
        return { path: target, success: false, error: "Path does not exist or is not accessible." };
      }
      if (entryStat.isSymbolicLink()) {
        return {
          path:    target,
          success: false,
          error:   "Refusing to delete symbolic links. Resolve the link target and provide the real path.",
        };
      }

      const sizeBytes = await treeSize(target);

      if (dryRun) {
        return { path: target, success: true, dryRun: true, sizeBytes, sizeHuman: formatBytes(sizeBytes) };
      }

      try {
        await fs.rm(target, { recursive: true, force: true });
        return { path: target, success: true, sizeBytes, sizeHuman: formatBytes(sizeBytes) };
      } catch (err) {
        return { path: target, success: false, error: (err as Error).message };
      }
    }),
  );

  const freedBytes = items
    .filter((i) => i.success)
    .reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0);

  return {
    dryRun,
    deletedCount: items.filter((i) => i.success && !i.dryRun).length,
    freedBytes,
    freedHuman:   formatBytes(freedBytes),
    items,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  console.log("delete_files smoke test — dryRun mode only (no files actually deleted)");
  run({ paths: [nodePath.join(os.homedir(), "nonexistent-test-file-xyz.tmp")], dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
