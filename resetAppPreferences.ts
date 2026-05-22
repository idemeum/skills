/**
 * mcp/skills/resetAppPreferences.ts — reset_app_preferences skill
 *
 * Removes an application's preferences file (plist on macOS, registry on
 * Windows) to force the app to use default settings. Defaults to dryRun=true
 * for safety.
 *
 * Platform strategy
 * -----------------
 * darwin  Scans ~/Library/Preferences for com.{appName}.* plist files
 * win32   PowerShell scans HKCU:\Software for matching registry keys
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/resetAppPreferences.ts Mail
 */

import * as fs        from "fs/promises";
import * as os        from "os";
import * as nodePath  from "path";
import { exec }       from "child_process";
import { promisify }  from "util";
import { z }          from "zod";
import { formatBytes } from "./_shared/formatBytes";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reset_app_preferences",
  description:
    "Removes an application's preferences file (plist on macOS, registry on " +
    "Windows) to force the app to use default settings. " +
    "Use when an app behaves erratically or after a corrupt preferences file is suspected.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    appName: z
      .string()
      .describe("Application name (e.g. 'Mail', 'Outlook', 'Slack')"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report what would be removed without removing. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface PrefEntry {
  path:      string;
  sizeMb:    number;
  /** Pre-formatted size (decimal/SI — matches Finder + Explorer). */
  sizeHuman: string;
}

interface PrefsResult {
  platform:       string;
  appName:        string;
  dryRun:         boolean;
  found:          PrefEntry[];
  /** Pre-formatted total across all found entries. Empty string when 0 bytes. */
  totalSizeHuman: string;
  deleted:        boolean;
  message:        string;
}

// -- Helpers ------------------------------------------------------------------

/** Prevent path traversal — ensure target stays within allowedRoot. */
function isSafePath(target: string, allowedRoot: string): boolean {
  const rel = nodePath.relative(allowedRoot, target);
  return !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

async function getFileSizeBytes(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/** Decimal/SI MB rounded to 3 decimals — matches Finder + Explorer. */
function bytesToMb(bytes: number): number {
  return Math.round((bytes / 1_000_000) * 1000) / 1000;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function resetAppPreferencesDarwin(
  appName: string,
  dryRun:  boolean,
): Promise<PrefsResult> {
  // Security: validate appName
  if (!/^[a-zA-Z0-9 _\-.']+$/.test(appName)) {
    throw new Error(`[reset_app_preferences] Invalid appName: ${appName}`);
  }

  const prefsDir = nodePath.join(os.homedir(), "Library", "Preferences");
  const lowerApp = appName.toLowerCase().replace(/\s+/g, "");

  let dirents: import("fs").Dirent[];
  try {
    dirents = await fs.readdir(prefsDir, { withFileTypes: true });
  } catch {
    return { platform: "darwin", appName, dryRun, found: [], totalSizeHuman: "0 B", deleted: false, message: "Could not read ~/Library/Preferences" };
  }

  // Match patterns: com.{appName}.*, {appName}.*, or files containing the app name
  const matchingFiles = dirents
    .filter((d) => d.isFile())
    .filter((d) => {
      const lower = d.name.toLowerCase();
      return (
        lower.startsWith(`com.${lowerApp}`) ||
        lower.startsWith(lowerApp) ||
        lower.includes(lowerApp)
      ) && lower.endsWith(".plist");
    });

  // Build entries while keeping a parallel byte total — sizeMb is rounded to
  // 3 decimals, which truncates sub-kilobyte files to 0 MB and would make
  // sum(sizeMb) lossy for small plists. Reduce on raw bytes for accuracy.
  const entries = await Promise.all(
    matchingFiles.map(async (d) => {
      const full  = nodePath.join(prefsDir, d.name);
      const bytes = await getFileSizeBytes(full);
      return { full, bytes };
    }),
  );

  const found: PrefEntry[] = entries.map((e) => ({
    path:      e.full,
    sizeMb:    bytesToMb(e.bytes),
    sizeHuman: formatBytes(e.bytes),
  }));

  const totalBytes     = entries.reduce((s, e) => s + e.bytes, 0);
  const totalSizeHuman = formatBytes(totalBytes);

  if (found.length === 0) {
    return {
      platform: "darwin",
      appName,
      dryRun,
      found,
      totalSizeHuman,
      deleted: false,
      message: `No preference files found for '${appName}' in ~/Library/Preferences`,
    };
  }

  if (dryRun) {
    return {
      platform: "darwin",
      appName,
      dryRun,
      found,
      totalSizeHuman,
      deleted: false,
      message: `Found ${found.length} preference file(s) (${totalSizeHuman}). Set dryRun=false to remove them.`,
    };
  }

  // Delete the files
  let deletedCount = 0;
  for (const entry of found) {
    if (!isSafePath(entry.path, prefsDir)) continue;
    try {
      await fs.unlink(entry.path);
      deletedCount++;
    } catch {
      // skip files we can't remove (e.g. locked)
    }
  }

  return {
    platform: "darwin",
    appName,
    dryRun,
    found,
    totalSizeHuman,
    deleted: deletedCount > 0,
    message: `Deleted ${deletedCount} of ${found.length} preference file(s) for '${appName}' (${totalSizeHuman}).`,
  };
}

// -- win32 implementation -----------------------------------------------------

async function resetAppPreferencesWin32(
  appName: string,
  dryRun:  boolean,
): Promise<PrefsResult> {
  if (!/^[a-zA-Z0-9 _\-.']+$/.test(appName)) {
    throw new Error(`[reset_app_preferences] Invalid appName: ${appName}`);
  }

  const safeApp = appName.replace(/'/g, "''");

  const findPs = `
$ErrorActionPreference = 'SilentlyContinue'
$base = 'HKCU:\\Software'
$matches = Get-ChildItem -Path $base -Recurse -ErrorAction SilentlyContinue |
  Where-Object { $_.PSChildName -like '*${safeApp}*' } |
  Select-Object -ExpandProperty PSPath
$matches | ConvertTo-Json -Compress`.trim();

  let registryKeys: string[] = [];
  try {
    const raw = await runPS(findPs);
    if (raw && raw !== "null") {
      const parsed = JSON.parse(raw) as string | string[];
      registryKeys = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    // fallback: empty
  }

  // Registry keys have no size on Windows; sizeMb is always 0 and sizeHuman
  // reflects that. The totalSizeHuman at the result level is still emitted
  // for consistency with the darwin path.
  const found: PrefEntry[] = registryKeys.map((k) => ({ path: k, sizeMb: 0, sizeHuman: "0 B" }));
  const totalSizeHuman = "0 B";

  if (found.length === 0) {
    return {
      platform: "win32",
      appName,
      dryRun,
      found,
      totalSizeHuman,
      deleted: false,
      message: `No registry keys found for '${appName}' under HKCU:\\Software`,
    };
  }

  if (dryRun) {
    return {
      platform: "win32",
      appName,
      dryRun,
      found,
      totalSizeHuman,
      deleted: false,
      message: `Found ${found.length} registry key(s). Set dryRun=false to remove them.`,
    };
  }

  // Delete registry keys
  const deleteOps = registryKeys.map((k) => `Remove-Item -LiteralPath '${k.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`).join("\n");
  const deletePs  = `$ErrorActionPreference = 'SilentlyContinue'\n${deleteOps}\nWrite-Output 'done'`;

  try {
    await runPS(deletePs);
    return {
      platform: "win32",
      appName,
      dryRun,
      found,
      totalSizeHuman,
      deleted: true,
      message: `Removed ${found.length} registry key(s) for '${appName}'.`,
    };
  } catch (err) {
    return {
      platform: "win32",
      appName,
      dryRun,
      found,
      totalSizeHuman,
      deleted: false,
      message: `Failed to remove registry keys: ${(err as Error).message}`,
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  appName,
  dryRun = true,
}: {
  appName: string;
  dryRun?: boolean;
}) {
  const platform = os.platform();
  return platform === "win32"
    ? resetAppPreferencesWin32(appName, dryRun)
    : resetAppPreferencesDarwin(appName, dryRun);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ appName: process.argv[2] ?? "Mail", dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
