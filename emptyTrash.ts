/**
 * mcp/skills/emptyTrash.ts — empty_trash skill
 *
 * Empties the system Trash (macOS) or Recycle Bin (Windows) and reports the
 * space freed.  A dryRun mode lets Claude show the user the impact first.
 *
 * IMPORTANT: Always confirm with the user before calling without dryRun.
 *
 * Platform strategy
 * -----------------
 * darwin  Primary path is AppleScript via Finder — Finder holds the TCC
 *         permission for ~/.Trash natively, so it works without granting
 *         Full Disk Access to the host app. Falls back to fs.rm if
 *         AppleScript is unavailable, and surfaces any errors clearly
 *         (EPERM / TCC failures are no longer silently swallowed).
 * win32   Shell.Application COM object for size; Clear-RecycleBin to empty.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/emptyTrash.ts --dry-run
 */

import * as fs           from "fs/promises";
import * as os           from "os";
import * as nodePath     from "path";
import { execFile }      from "child_process";
import { promisify }     from "util";
import { z }             from "zod";

import { loggedExec } from "./_shared/platform";

const execFileAsync = promisify(execFile);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "empty_trash",
  description:
    "Empties the system Trash (macOS) or Recycle Bin (Windows) and reports " +
    "the space freed. Always confirm with the user before calling without dryRun.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "When true, reports how much would be freed without actually emptying. " +
        "Default: false.",
      ),
  },
} as const;

// -- Helpers ------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

async function runPS(script: string, tag: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await loggedExec(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { tag: `empty_trash:${tag}`, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}

/** Run an AppleScript snippet via osascript; returns stdout (trimmed).
 *
 * Uses execFile (not exec/shell) so the script string is passed as a direct
 * argv element to osascript.  exec() → JSON.stringify() turns real newlines
 * into the two-character sequence \n, which the shell leaves as literal
 * backslash-n inside double quotes — osascript then raises syntax error -2741
 * because AppleScript requires actual newlines between statements.
 */
async function runOsa(script: string, tag: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

/** True if an Error looks like a TCC / permission denial from macOS. */
function isTccError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("operation not permitted") ||
    m.includes("not authorized") ||
    m.includes("eperm") ||
    m.includes("eacces") ||
    m.includes("errauthorizationcanceled") ||
    m.includes("not allowed assistive access") ||
    m.includes("(-1743)") || // automation permission denied
    m.includes("(-1728)")    // object not found (often a TCC symptom)
  );
}

// -- darwin implementation ----------------------------------------------------

interface TrashInfo { bytes: number; itemCount: number; error?: string }

/**
 * Measure trash via AppleScript (Finder). Finder has the TCC permission to
 * read ~/.Trash even when the host Electron app does not.
 */
async function measureTrashDarwinOsa(): Promise<TrashInfo> {
  // Use the POSIX trash path via Finder. `size of` on each item avoids needing
  // Full Disk Access on the host process. `every item` excludes .DS_Store by
  // default (Finder hides it).
  const script = `
tell application "Finder"
  set trashItems to items of trash
  set itemCount to count of trashItems
  set totalBytes to 0
  repeat with anItem in trashItems
    try
      set totalBytes to totalBytes + (size of anItem)
    end try
  end repeat
end tell
return (itemCount as text) & "," & (totalBytes as text)`.trim();
  const out = await runOsa(script, "osa-measure");
  const [countStr, bytesStr] = out.split(",");
  return {
    itemCount: parseInt(countStr ?? "0", 10) || 0,
    bytes:     parseInt(bytesStr ?? "0", 10) || 0,
  };
}

/** Fallback direct-fs measurement (only works with Full Disk Access). */
async function measureTrashDarwinFs(trashPath: string): Promise<TrashInfo> {
  let bytes     = 0;
  let itemCount = 0;
  const entries = await fs.readdir(trashPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    itemCount++;
    try {
      const stat = await fs.stat(nodePath.join(trashPath, e.name));
      bytes += stat.size;
    } catch { /* skip unreadable entries */ }
  }
  return { bytes, itemCount };
}

async function measureTrashDarwin(trashPath: string): Promise<TrashInfo> {
  // Try AppleScript first (works without Full Disk Access).
  try {
    return await measureTrashDarwinOsa();
  } catch (osaErr) {
    // Fall back to direct fs — may work if app has Full Disk Access.
    try {
      return await measureTrashDarwinFs(trashPath);
    } catch (fsErr) {
      const tcc = isTccError(osaErr) || isTccError(fsErr);
      return {
        bytes:     0,
        itemCount: 0,
        error: tcc
          ? "Cannot read ~/.Trash — macOS TCC permission denied. To fix: open System Settings → Privacy & Security → Automation → find 'AI Support Agent' (or 'Electron' in dev) → enable the checkbox for Finder. Alternatively, grant Full Disk Access to the app in Privacy & Security → Full Disk Access. After granting, fully quit and relaunch the app."
          : `Failed to measure trash: ${(osaErr as Error).message}`,
      };
    }
  }
}

async function emptyTrashDarwin(dryRun: boolean) {
  const trashPath = nodePath.join(os.homedir(), ".Trash");
  const measured  = await measureTrashDarwin(trashPath);

  if (dryRun) {
    return {
      dryRun:       true,
      itemsInTrash: measured.itemCount,
      freedBytes:   measured.bytes,
      freedHuman:   formatBytes(measured.bytes),
      ...(measured.error ? { warning: measured.error } : {}),
    };
  }

  // Primary path — ask Finder to empty the trash. Finder holds the TCC
  // permission natively; this also handles locked items and trash folders
  // on mounted external volumes.
  let method: "finder" | "fs" = "finder";
  let emptyError: string | undefined;
  try {
    await runOsa(`tell application "Finder" to empty trash`, "osa-empty");
  } catch (osaErr) {
    // Fall back to direct fs.rm — only works with Full Disk Access.
    method = "fs";
    try {
      const entries = await fs.readdir(trashPath);
      const results = await Promise.allSettled(
        entries.map((e) =>
          fs.rm(nodePath.join(trashPath, e), { recursive: true, force: true }),
        ),
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        const firstErr = (failures[0] as PromiseRejectedResult).reason as Error;
        emptyError = isTccError(firstErr) || isTccError(osaErr)
          ? `Could not empty trash — macOS TCC permission denied. To fix: open System Settings → Privacy & Security → Automation → find 'AI Support Agent' (or 'Electron' in dev) → enable the checkbox for Finder. Alternatively, grant Full Disk Access. After granting, fully quit and relaunch the app, then try again. (${failures.length}/${results.length} items failed)`
          : `Failed to remove ${failures.length}/${results.length} items: ${firstErr.message}`;
      }
    } catch (fsErr) {
      emptyError = isTccError(osaErr) || isTccError(fsErr)
        ? "Could not empty trash — macOS TCC permission denied. To fix: open System Settings → Privacy & Security → Automation → find 'AI Support Agent' (or 'Electron' in dev) → enable the checkbox for Finder. Alternatively, grant Full Disk Access. After granting, fully quit and relaunch the app, then try again."
        : `Failed to empty trash: ${(fsErr as Error).message}`;
    }
  }

  // Verify by re-measuring. This tells us what *actually* got freed.
  const after        = await measureTrashDarwin(trashPath);
  const freedBytes   = Math.max(0, measured.bytes     - after.bytes);
  const itemsRemoved = Math.max(0, measured.itemCount - after.itemCount);

  // ── Silent-failure detection ────────────────────────────────────────────────
  // If the empty operation reported success (no thrown error → emptyError
  // unset) but the before-measurement showed items and zero were actually
  // removed, Finder accepted the AppleScript but did not perform the operation.
  // This is the defining symptom of macOS TCC silently denying Apple Events
  // to Finder — osascript exits 0, nothing happens. Surface a clear, actionable
  // error so the user knows what to fix; without this, the agent reports fake
  // success and the trash stays full.
  if (
    emptyError === undefined &&
    measured.itemCount > 0 &&
    itemsRemoved === 0
  ) {
    emptyError =
      "Trash was not actually emptied (Finder reported success but the items remain). " +
      "This usually means AI Support Agent does not have permission to automate Finder. " +
      "Open System Settings → Privacy & Security → Automation, find AI Support Agent, " +
      "and enable the Finder checkbox. Then quit and relaunch AI Support Agent.";
  }

  return {
    dryRun:          false,
    method,
    itemsRemoved,
    itemsRemaining:  after.itemCount,
    freedBytes,
    freedHuman:      formatBytes(freedBytes),
    ...(emptyError ? { error: emptyError } : {}),
  };
}

// -- win32 implementation -----------------------------------------------------

async function emptyTrashWin32(dryRun: boolean) {
  // Query Recycle Bin size via Shell.Application COM object (works on all Windows versions).
  const sizeScript = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$bin   = $shell.Namespace(0xA)
$items = $bin.Items()
[PSCustomObject]@{
  bytes = [long](($items | ForEach-Object { $_.Size } | Measure-Object -Sum).Sum ?? 0)
  items = [int]$items.Count
} | ConvertTo-Json -Compress`.trim();

  let bytes = 0;
  let items = 0;
  try {
    const out    = await runPS(sizeScript, "ps-measure");
    const parsed = JSON.parse(out) as { bytes: number; items: number };
    bytes = parsed.bytes ?? 0;
    items = parsed.items ?? 0;
  } catch { /* best-effort — proceed even if size query fails */ }

  if (dryRun) {
    return { dryRun: true, itemsInTrash: items, freedBytes: bytes, freedHuman: formatBytes(bytes) };
  }

  const clearScript = `Clear-RecycleBin -Force -ErrorAction SilentlyContinue; exit 0`;
  await runPS(clearScript, "ps-clear").catch(() => { /* ignore — Clear-RecycleBin is best-effort */ });

  return { dryRun: false, itemsRemoved: items, freedBytes: bytes, freedHuman: formatBytes(bytes) };
}

// -- Exported run function ----------------------------------------------------

export async function run({ dryRun = false }: { dryRun?: boolean } = {}) {
  const platform = os.platform();

  if (platform === "win32") return emptyTrashWin32(dryRun);
  if (platform === "darwin") return emptyTrashDarwin(dryRun);

  throw new Error(
    `[empty_trash] Unsupported platform: ${platform}. ` +
    "Supported: darwin, win32.",
  );
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`empty_trash smoke test — dryRun=${dryRun}`);
  run({ dryRun })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
