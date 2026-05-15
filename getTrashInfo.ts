/**
 * mcp/skills/getTrashInfo.ts — get_trash_info skill
 *
 * Reports macOS Trash / Windows Recycle Bin contents (item count + total
 * bytes) without modifying anything.  Read-only counterpart to
 * `empty_trash` — designed for synthesis-then-confirm skills (e.g.
 * disk-cleanup) that need a diagnostic size feed for the consolidated
 * present_preview card without invoking the destructive tool's dryRun
 * branch (which collides with G4's auto dry-run gate).
 *
 * Platform strategy
 * -----------------
 * darwin  Primary: AppleScript via Finder (TCC for ~/.Trash native to
 *         Finder; no Full Disk Access on the host required).
 *         Fallback: direct fs.readdir + stat on ~/.Trash (Full Disk
 *         Access required to succeed).  Errors surface as `errors[]`
 *         rather than throwing.
 * win32   Shell.Application COM via PowerShell — same query as
 *         empty_trash's dryRun path.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getTrashInfo.ts
 *
 * NOTE: measurement logic is intentionally duplicated from
 * `emptyTrash.ts` — keep in sync with that file if the underlying
 * Trash measurement strategy changes.
 */

import * as fs           from "fs/promises";
import * as os           from "os";
import * as nodePath     from "path";
import { execFile }      from "child_process";
import { promisify }     from "util";

import { loggedExec, isDarwin, isWin32 } from "./_shared/platform";

const execFileAsync = promisify(execFile);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_trash_info",
  description:
    "Reports the system Trash (macOS) or Recycle Bin (Windows) contents — " +
    "item count and total bytes — without modifying anything. Read-only " +
    "counterpart to empty_trash. Use this in diagnostic phases to feed a " +
    "present_preview card without invoking the destructive tool.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess", "Automation"],
  schema:          {},
} as const;

// -- Types --------------------------------------------------------------------

export interface GetTrashInfoResult {
  platform:    NodeJS.Platform;
  itemCount:   number;
  totalBytes:  number;
  totalHuman:  string;
  errors?:     Array<{ scope: string; message: string }>;
}

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
    { tag: `get_trash_info:${tag}`, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.trim();
}

async function runOsa(script: string): Promise<string> {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

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
    m.includes("(-1743)") ||
    m.includes("(-1728)")
  );
}

interface TrashMeasurement { bytes: number; itemCount: number; error?: string }

// -- darwin -------------------------------------------------------------------

async function measureViaFinder(): Promise<TrashMeasurement> {
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
  const out = await runOsa(script);
  const [countStr, bytesStr] = out.split(",");
  return {
    itemCount: parseInt(countStr ?? "0", 10) || 0,
    bytes:     parseInt(bytesStr ?? "0", 10) || 0,
  };
}

async function measureViaFs(trashPath: string): Promise<TrashMeasurement> {
  let bytes     = 0;
  let itemCount = 0;
  const entries = await fs.readdir(trashPath, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    itemCount++;
    try {
      const stat = await fs.stat(nodePath.join(trashPath, e.name));
      bytes += stat.size;
    } catch { /* skip unreadable */ }
  }
  return { bytes, itemCount };
}

async function getTrashInfoDarwin(): Promise<GetTrashInfoResult> {
  const trashPath = nodePath.join(os.homedir(), ".Trash");
  const errors: GetTrashInfoResult["errors"] = [];

  let measured: TrashMeasurement | null = null;
  try {
    measured = await measureViaFinder();
  } catch (osaErr) {
    try {
      measured = await measureViaFs(trashPath);
    } catch (fsErr) {
      const tcc = isTccError(osaErr) || isTccError(fsErr);
      errors.push({
        scope:   "user-trash",
        message: tcc
          ? "Cannot read ~/.Trash — macOS TCC permission denied. Open System Settings → Privacy & Security → Automation, enable Finder for AI Support Agent, or grant Full Disk Access."
          : `Failed to measure trash: ${(osaErr as Error).message}`,
      });
    }
  }

  return {
    platform:   "darwin",
    itemCount:  measured?.itemCount ?? 0,
    totalBytes: measured?.bytes ?? 0,
    totalHuman: formatBytes(measured?.bytes ?? 0),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// -- win32 --------------------------------------------------------------------

async function getTrashInfoWin32(): Promise<GetTrashInfoResult> {
  const sizeScript = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$bin   = $shell.Namespace(0xA)
$items = $bin.Items()
[PSCustomObject]@{
  bytes = [long](($items | ForEach-Object { $_.Size } | Measure-Object -Sum).Sum ?? 0)
  items = [int]$items.Count
} | ConvertTo-Json -Compress`.trim();

  const errors: GetTrashInfoResult["errors"] = [];
  let bytes = 0;
  let items = 0;
  try {
    const out    = await runPS(sizeScript, "ps-measure");
    const parsed = JSON.parse(out) as { bytes: number; items: number };
    bytes = parsed.bytes ?? 0;
    items = parsed.items ?? 0;
  } catch (err) {
    errors.push({ scope: "recycle-bin", message: (err as Error).message });
  }

  return {
    platform:   "win32",
    itemCount:  items,
    totalBytes: bytes,
    totalHuman: formatBytes(bytes),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// -- Exported run -------------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetTrashInfoResult> {
  if (isDarwin()) return getTrashInfoDarwin();
  if (isWin32())  return getTrashInfoWin32();
  return {
    platform:   os.platform(),
    itemCount:  0,
    totalBytes: 0,
    totalHuman: "0 B",
    errors:     [{ scope: "platform", message: `unsupported platform: ${os.platform()}` }],
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
