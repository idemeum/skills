/**
 * mcp/skills/uninstallApp.ts — uninstall_app skill
 *
 * Removes an application bundle and associated support files (preferences,
 * caches, app support data, logs). More thorough than Trash. Use before
 * reinstalling for a clean state.
 *
 * Platform strategy
 * -----------------
 * darwin  Find .app in /Applications and ~/Applications, then remove support
 *         files from ~/Library when deep=true
 * win32   PowerShell Get-Package / Uninstall-Package or registry uninstaller
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/uninstallApp.ts
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "uninstall_app",
  description:
    "Removes an application bundle and associated support files (preferences, caches, " +
    "app support data, logs). More thorough than Trash. Use before reinstalling for a clean state.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    appName: z
      .string()
      .describe("Application name (e.g. 'Zoom', 'Slack')"),
    deep: z
      .boolean()
      .optional()
      .describe("Also remove support files in ~/Library. Default: false"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, list files that would be removed. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface UninstallResult {
  appBundle:      string | null;
  supportFiles:   string[];
  totalSizeMb:    number;
  removed:        boolean;
  dryRun:         boolean;
  message:        string;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin: calculate size with du -sk ---------------------------------------

async function getDiskUsageKb(targetPath: string): Promise<number> {
  try {
    const safePath = targetPath.replace(/'/g, `'\\''`);
    const { stdout } = await execAsync(
      `du -sk '${safePath}' 2>/dev/null`,
      { maxBuffer: 2 * 1024 * 1024, shell: "/bin/bash" },
    );
    const kb = parseInt(stdout.trim().split("\t")[0], 10);
    return isNaN(kb) ? 0 : kb;
  } catch {
    return 0;
  }
}

// -- darwin: glob support files in ~/Library ----------------------------------

async function findSupportFiles(appName: string): Promise<string[]> {
  const home        = os.homedir();
  const libBase     = nodePath.join(home, "Library");
  const searchDirs  = [
    nodePath.join(libBase, "Application Support"),
    nodePath.join(libBase, "Caches"),
    nodePath.join(libBase, "Preferences"),
    nodePath.join(libBase, "Logs"),
  ];
  const found: string[] = [];
  const lowerName       = appName.toLowerCase();

  for (const dir of searchDirs) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.toLowerCase().includes(lowerName)) {
          found.push(nodePath.join(dir, entry));
        }
      }
    } catch {
      // Directory may not exist or be inaccessible
    }
  }
  return found;
}

// -- darwin implementation ----------------------------------------------------

async function uninstallAppDarwin(
  appName: string,
  deep:    boolean,
  dryRun:  boolean,
): Promise<UninstallResult> {
  // Locate .app bundle
  let appBundle: string | null = null;
  const searchLocations        = [
    `/Applications/${appName}.app`,
    nodePath.join(os.homedir(), "Applications", `${appName}.app`),
  ];

  for (const loc of searchLocations) {
    try {
      await fs.access(loc);
      appBundle = loc;
      break;
    } catch {
      // Try next location
    }
  }

  // Also try find if exact match not found
  if (!appBundle) {
    try {
      const safeName   = appName.replace(/'/g, `'\\''`);
      const { stdout } = await execAsync(
        `find /Applications ~/Applications -maxdepth 2 -name '${safeName}.app' 2>/dev/null`,
        { maxBuffer: 1024 * 1024, shell: "/bin/bash" },
      );
      appBundle = stdout.trim().split("\n")[0] || null;
    } catch {
      appBundle = null;
    }
  }

  // Gather support files
  const supportFiles: string[] = deep ? await findSupportFiles(appName) : [];

  // Calculate total size
  const allPaths    = [...(appBundle ? [appBundle] : []), ...supportFiles];
  let totalSizeKb   = 0;
  for (const p of allPaths) {
    totalSizeKb += await getDiskUsageKb(p);
  }
  const totalSizeMb = Math.round((totalSizeKb / 1024) * 10) / 10;

  if (dryRun) {
    return {
      appBundle,
      supportFiles,
      totalSizeMb,
      removed: false,
      dryRun:  true,
      message: appBundle
        ? `Dry run: would remove app bundle and ${supportFiles.length} support file(s). Total: ~${totalSizeMb} MB`
        : `App bundle for "${appName}" not found. ${supportFiles.length} support file(s) found.`,
    };
  }

  // Perform removal
  let removed = false;
  const errors: string[] = [];
  for (const p of allPaths) {
    try {
      await fs.rm(p, { recursive: true, force: true });
      removed = true;
    } catch (err) {
      errors.push(`Failed to remove ${p}: ${(err as Error).message}`);
    }
  }

  return {
    appBundle,
    supportFiles,
    totalSizeMb,
    removed,
    dryRun: false,
    message: errors.length === 0
      ? `Removed app bundle and ${supportFiles.length} support file(s). ~${totalSizeMb} MB freed.`
      : `Partial removal. Errors: ${errors.join("; ")}`,
  };
}

// -- win32 implementation -----------------------------------------------------

async function uninstallAppWin32(
  appName: string,
  _deep:   boolean,
  dryRun:  boolean,
): Promise<UninstallResult> {
  const safeAppName = appName.replace(/'/g, "''");

  if (dryRun) {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$pkg = Get-Package -Name '*${safeAppName}*' -ErrorAction SilentlyContinue | Select-Object Name,Version,Source
if ($pkg) { @($pkg) | ConvertTo-Json -Compress } else { '[]' }`.trim();

    let found = false;
    let info   = "";
    try {
      const raw    = await runPS(ps);
      const parsed = JSON.parse(raw ?? "[]") as Array<{ Name: string; Version: string }>;
      if (parsed.length > 0) {
        found = true;
        info  = parsed.map((p) => `${p.Name} v${p.Version}`).join(", ");
      }
    } catch {
      info = "Could not query installed packages";
    }
    return {
      appBundle:    found ? info : null,
      supportFiles: [],
      totalSizeMb:  0,
      removed:      false,
      dryRun:       true,
      message:      found
        ? `Dry run: found "${info}". Run with dryRun=false to uninstall.`
        : `Package matching "${appName}" not found via Get-Package.`,
    };
  }

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$pkg = Get-Package -Name '*${safeAppName}*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pkg) {
  Uninstall-Package -Name $pkg.Name -Force -ErrorAction SilentlyContinue
  "uninstalled:$($pkg.Name)"
} else {
  # Try registry uninstaller fallback
  $reg = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue |
         Get-ItemProperty -ErrorAction SilentlyContinue |
         Where-Object { $_.DisplayName -match '${safeAppName}' } |
         Select-Object -First 1
  if ($reg -and $reg.UninstallString) {
    $uninstCmd = $reg.UninstallString + ' /quiet /norestart'
    Start-Process cmd -ArgumentList ("/c " + $uninstCmd) -Wait
    "uninstalled_via_registry:$($reg.DisplayName)"
  } else {
    "not_found"
  }
}`.trim();

  let removed = false;
  let message = "";
  try {
    const raw = await runPS(ps);
    if (raw.startsWith("uninstalled")) {
      removed = true;
      message = `Uninstalled: ${raw.split(":")[1] ?? appName}`;
    } else {
      message = `Package "${appName}" not found or could not be uninstalled via standard methods.`;
    }
  } catch (err) {
    message = `Uninstall error: ${(err as Error).message}`;
  }

  return {
    appBundle:    appName,
    supportFiles: [],
    totalSizeMb:  0,
    removed,
    dryRun:       false,
    message,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  appName,
  deep   = false,
  dryRun = true,
}: {
  appName: string;
  deep?:   boolean;
  dryRun?: boolean;
}) {
  const platform = os.platform();
  return platform === "win32"
    ? uninstallAppWin32(appName, deep, dryRun)
    : uninstallAppDarwin(appName, deep, dryRun);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ appName: "Zoom", deep: false, dryRun: true })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
