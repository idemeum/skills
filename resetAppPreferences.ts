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
      .nullable().optional()
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

  const homeLib  = nodePath.join(os.homedir(), "Library");
  const prefsDir = nodePath.join(homeLib, "Preferences");
  const lowerApp = appName.toLowerCase().replace(/\s+/g, "");

  // Normalise away ALL non-alphanumerics on both sides before the substring
  // match. Reverse-DNS preference domains separate the vendor and app with a
  // dot (com.microsoft.Outlook.plist), so collapsing only spaces left
  // "Microsoft Outlook" -> "microsoftoutlook", which is NOT a substring of
  // "...microsoft.outlook..." -> the reset silently matched zero files.
  // Stripping the dots too ("commicrosoftoutlook") makes the match hold.
  const norm     = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wantNorm = norm(appName);

  const matches = (fileName: string): boolean => {
    const lower = fileName.toLowerCase();
    if (!lower.endsWith(".plist")) return false;
    const fileNorm = norm(fileName.replace(/\.plist$/i, ""));
    return lower.startsWith(`com.${lowerApp}`) || lower.startsWith(lowerApp) || fileNorm.includes(wantNorm);
  };

  // Scan ~/Library/Preferences AND every sandbox container's preferences dir.
  // Sandboxed apps (e.g. Apple Mail) keep their REAL prefs under
  // ~/Library/Containers/<bundle-id>/Data/Library/Preferences — NOT in
  // ~/Library/Preferences — so a Preferences-only scan missed the actual file
  // and only ever hit collateral helper plists.
  const prefDirs: string[] = [prefsDir];
  try {
    const containers = await fs.readdir(nodePath.join(homeLib, "Containers"), { withFileTypes: true });
    for (const c of containers) {
      if (!c.isDirectory()) continue;
      // Only descend into containers whose bundle id relates to the target app.
      // Scanning EVERY container's prefs dir (hundreds on a real Mac) is far too
      // slow; filtering by the app token keeps it fast and cuts collateral.
      if (c.name.toLowerCase().startsWith(`com.${lowerApp}`) || norm(c.name).includes(wantNorm)) {
        prefDirs.push(nodePath.join(homeLib, "Containers", c.name, "Data", "Library", "Preferences"));
      }
    }
  } catch {
    // No Containers dir (or unreadable) — fall back to ~/Library/Preferences only.
  }

  const matchedPaths: string[] = [];
  let tccBlocked = 0;
  for (const dir of prefDirs) {
    let dirents: import("fs").Dirent[];
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      // ENOENT = container has no prefs dir (normal — skip). EPERM/EACCES = macOS
      // TCC blocking a sandboxed location (e.g. Apple Mail's own com.apple.mail
      // container needs Full Disk Access). Never swallow that silently — count it
      // so the result can surface that some real prefs could not be reached.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") tccBlocked++;
      continue;
    }
    for (const d of dirents) {
      if (d.isFile() && matches(d.name)) matchedPaths.push(nodePath.join(dir, d.name));
    }
  }

  const tccNote = tccBlocked > 0
    ? ` Note: ${tccBlocked} sandboxed preference location(s) are blocked by macOS privacy protection — grant this app Full Disk Access to reset those (e.g. Apple Mail's own container).`
    : "";

  // Build entries with a parallel byte total (sizeMb rounds to 3 decimals,
  // lossy for sub-kB plists; reduce on raw bytes for accuracy).
  const entries = await Promise.all(
    matchedPaths.map(async (full) => ({ full, bytes: await getFileSizeBytes(full) })),
  );

  const found: PrefEntry[] = entries.map((e) => ({
    path:      e.full,
    sizeMb:    bytesToMb(e.bytes),
    sizeHuman: formatBytes(e.bytes),
  }));

  const totalSizeHuman = formatBytes(entries.reduce((s, e) => s + e.bytes, 0));

  if (found.length === 0) {
    return {
      platform: "darwin", appName, dryRun, found, totalSizeHuman, deleted: false,
      message: `No preference files found for '${appName}' (checked ~/Library/Preferences and sandbox containers).${tccNote}`,
    };
  }

  if (dryRun) {
    return {
      platform: "darwin", appName, dryRun, found, totalSizeHuman, deleted: false,
      message: `Found ${found.length} preference file(s) (${totalSizeHuman}). Each will be backed up to a .bak alongside it (reversible) when you confirm.${tccNote}`,
    };
  }

  // Back up (rename to .bak) rather than delete outright — a "high" risk reset
  // must be reversible. The app starts fresh because the original is gone from
  // its active location; renaming a .bak back restores the prior settings.
  let resetCount = 0;
  for (const entry of found) {
    if (!isSafePath(entry.path, homeLib)) continue; // stay within ~/Library
    const bak = `${entry.path}.bak`;
    try {
      await fs.rm(bak, { force: true });   // clear a stale backup from a prior run
      await fs.rename(entry.path, bak);
      resetCount++;
    } catch {
      // locked / unmovable — skip
    }
  }

  return {
    platform: "darwin", appName, dryRun, found, totalSizeHuman,
    deleted: resetCount > 0,
    message: `Reset ${resetCount} of ${found.length} preference file(s) for '${appName}' (${totalSizeHuman}). Originals backed up to <file>.bak — rename back to restore.${tccNote}`,
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
