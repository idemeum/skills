/**
 * mcp/skills/diskScan.ts — disk_scan skill
 *
 * Scans a directory and returns the size of every immediate child entry,
 * sorted largest first.  Helps Claude answer "what is using my disk space?"
 *
 * Platform strategy
 * -----------------
 * darwin  `du -sk <dir>/*` — fast, OS-native, gives recursive dir sizes
 * win32   PowerShell via -EncodedCommand — recursive Measure-Object per child
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/diskScan.ts [/optional/path]
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { z }         from "zod";

import { loggedExec } from "./_shared/platform";
import { expandTilde } from "./_shared/expandTilde";
import { formatBytes } from "./_shared/formatBytes";
import { getDirSizeBytes } from "./_shared/dirSize";

// Re-export so existing test imports (`import { formatBytes } from "./diskScan"`)
// continue to resolve.  No production consumer imports formatBytes from this
// module — kept purely for test back-compat.
export { formatBytes };

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "disk_scan",
  description:
    "Scans a directory and returns the size of each immediate child entry " +
    "(files and sub-folders), sorted largest first. " +
    "Use when the user wants to find what is consuming disk space.",
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
      .nullable().optional()
      .describe(
        "Absolute path of the directory to scan. " +
        "Defaults to the user home directory.",
      ),
  },
} as const;

// formatBytes is imported from _shared/formatBytes (and re-exported above
// for test back-compat).

interface Entry {
  name:      string;
  path:      string;
  size:      number;
  sizeHuman: string;
  type:      "file" | "directory";
}

// -- PowerShell helper --------------------------------------------------------

export async function runPS(script: string, tag = "ps"): Promise<string> {
  // -EncodedCommand accepts Base64 UTF-16LE — avoids all shell quoting issues.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await loggedExec(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { tag: `disk_scan:${tag}`, maxBuffer: 20 * 1024 * 1024, timeoutMs: 60_000 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

/** Fallback: stat immediate children (used when du output is empty). */
async function statChildren(scanPath: string): Promise<Entry[]> {
  const dirents = await fs.readdir(scanPath, { withFileTypes: true });
  const settled = await Promise.allSettled(
    dirents.map(async (e) => {
      const full = nodePath.join(scanPath, e.name);
      const stat = await fs.stat(full);
      return {
        name:      e.name,
        path:      full,
        size:      stat.size,
        sizeHuman: formatBytes(stat.size),
        type:      (e.isDirectory() ? "directory" : "file") as Entry["type"],
      };
    }),
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<Entry> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => b.size - a.size);
}

async function scanDarwin(scanPath: string): Promise<Entry[]> {
  // du exits non-zero when some children are permission-denied — stdout still useful.
  // We do NOT redirect stderr to /dev/null any more: loggedExec captures it and
  // detects TCC patterns ("Operation not permitted", EPERM, etc.) so partial
  // results from missing Full Disk Access become visible in idemeum-agent.log.
  let stdout = "";
  try {
    // Security: use single-quoted path to prevent shell injection.
    // Single-quoted strings cannot contain command substitution ($(), ``)
    // or variable expansion. Escape any literal single quotes by ending
    // the string, inserting a backslash-quoted ', then restarting.
    const safePath = scanPath.replace(/'/g, `'\\''`);
    ({ stdout } = await loggedExec(
      `du -sk '${safePath}'/*`,
      { tag: "disk_scan:du", maxBuffer: 20 * 1024 * 1024, timeoutMs: 60_000 },
    ));
  } catch (err) {
    // A timeout-killed du leaves only the entries that finished quickly in
    // stdout — typically tiny dotfiles, with the actual large directories
    // missing. Returning that partial output silently misleads the cleanup
    // planner. Treat killed-by-signal as fatal; only fall back to partial
    // stdout when du exited normally with errors (e.g. TCC denials).
    const e = err as { stdout?: string; killed?: boolean; signal?: string };
    if (e.killed || e.signal) {
      throw new Error(
        `[disk_scan] du timed out after 60s scanning ${scanPath} — ` +
        `partial results suppressed to avoid misleading the cleanup planner.`,
      );
    }
    stdout = e.stdout ?? "";
  }

  if (!stdout.trim()) return statChildren(scanPath);

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab  = line.indexOf("\t");
      const kb   = parseInt(line.slice(0, tab), 10);
      const full = line.slice(tab + 1).trim();
      const size = kb * 1024; // du -k reports 1024-byte blocks
      return {
        name:      nodePath.basename(full),
        path:      full,
        size,
        sizeHuman: formatBytes(size),
        type:      "directory" as Entry["type"],
      };
    })
    .sort((a, b) => b.size - a.size);
}

// -- win32 implementation -----------------------------------------------------

async function scanWin32(scanPath: string, deadlineMs: number): Promise<Entry[]> {
  const dirents = await fs.readdir(scanPath, { withFileTypes: true });
  const results = await Promise.all(
    dirents.map(async (e): Promise<Entry> => {
      const full = nodePath.join(scanPath, e.name);
      if (e.isDirectory()) {
        const { sizeBytes } = await getDirSizeBytes(full, deadlineMs);
        return {
          name: e.name, path: full, size: sizeBytes,
          sizeHuman: formatBytes(sizeBytes), type: "directory",
        };
      }
      const stat = await fs.stat(full).catch(() => null);
      const size = stat?.size ?? 0;
      return {
        name: e.name, path: full, size,
        sizeHuman: formatBytes(size), type: "file",
      };
    }),
  );
  return results.sort((a, b) => b.size - a.size);
}

// -- Exported run function ----------------------------------------------------

interface RunCtx { deadlineMs?: number }

export async function run(
  { path: inputPath = os.homedir() }: { path?: string },
  ctx?: RunCtx,
) {
  const ceilingMs   = ctx?.deadlineMs ?? (Date.now() + 60_000);
  const remainingMs = Math.max(0, ceilingMs - Date.now());
  const deadlineMs  = Date.now() + Math.floor(remainingMs * 0.9);
  // Expand ~ / ~/ before resolve() — see _shared/expandTilde.ts for the
  // background on why this is necessary across every path-accepting tool.
  // Treat empty string the same as omitted — nodePath.resolve("") returns
  // process.cwd() (the app install dir) rather than home, which always fails
  // the home-directory safety check.
  const effectivePath = inputPath || os.homedir();
  const scanPath = nodePath.resolve(expandTilde(effectivePath) ?? effectivePath);

  // Security: restrict scanning to within the user home directory.
  // Prevents Claude from being directed to scan /etc, /var, or other
  // system paths that could leak sensitive file names to the LLM context.
  const home = os.homedir();
  const rel  = nodePath.relative(home, scanPath);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(
      `[disk_scan] Path must be within home directory (${home}): ${scanPath}`,
    );
  }

  try {
    await fs.access(scanPath);
  } catch {
    throw new Error(`[disk_scan] Path not accessible: ${scanPath}`);
  }

  const platform = os.platform();
  const entries  = platform === "win32"
    ? await scanWin32(scanPath, deadlineMs)
    : await scanDarwin(scanPath);

  // ── Partial-result detection ────────────────────────────────────────────────
  // Compare the entry count we got back from `du`/PowerShell against what
  // fs.readdir reports for the same directory. A significant shortfall is
  // almost always a TCC denial — without Full Disk Access, du can list a
  // path it cannot recurse into, so children disappear silently. Surface
  // this so the user knows the scan is incomplete instead of trusting
  // partial sizes for cleanup decisions.
  let warning: string | undefined;
  try {
    // Exclude dotfiles: `du -sk <path>/*` shell-globs to non-hidden children
    // only (bash default), so comparing against a readdir that includes
    // dotfiles would treat every dotfile as "skipped" and falsely fire the
    // warning on any developer home dir with .npm / .m2 / .ssh / etc.
    const expected = (await fs.readdir(scanPath))
      .filter((n) => n !== ".DS_Store" && !n.startsWith("."));
    if (expected.length > 0) {
      const skipped = Math.max(0, expected.length - entries.length);
      const ratio   = skipped / expected.length;
      if (ratio > 0.2) {
        warning =
          `Scan results are incomplete: ${skipped} of ${expected.length} children ` +
          `could not be read (likely missing Full Disk Access). ` +
          `Open System Settings → Privacy & Security → Full Disk Access, ` +
          `enable AI Support Agent, then quit and relaunch.`;
      }
    }
  } catch {
    // readdir itself failed — main scan likely already failed too; let the
    // empty entries result speak for itself.
  }

  return {
    scannedPath: scanPath,
    platform,
    entryCount:  entries.length,
    entries,
    ...(warning ? { warning } : {}),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run({ path: process.argv[2] })
    .then((r) => {
      console.log(`\nScanned: ${r.scannedPath}  (${r.entryCount} entries)\n`);
      r.entries.slice(0, 10).forEach((e) =>
        console.log(
          `  ${e.sizeHuman.padStart(10)}  ${e.type === "directory" ? "[DIR]" : "[FILE]"}  ${e.name}`,
        ),
      );
    })
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
