/**
 * mcp/skills/listInstalledApps.ts — list_installed_apps skill
 *
 * Lists all installed applications with their names, versions, and install
 * locations. Useful for checking if software is installed, finding outdated
 * apps, or before reinstalling an application.
 *
 * Platform strategy
 * -----------------
 * darwin  `system_profiler SPApplicationsDataType -json` — comprehensive app list
 * win32   PowerShell Get-Package | ConvertTo-Json
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/listInstalledApps.ts [filter]
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_installed_apps",
  description:
    "Lists all installed applications with their names, versions, and install " +
    "locations. Use when checking if software is installed, finding outdated " +
    "apps, or before reinstalling an application.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    filter: z
      .string()
      .optional()
      .describe("Case-insensitive name filter to narrow results"),
    includeSystemApps: z
      .boolean()
      .optional()
      .describe("Include Apple/Microsoft system apps. Default: false"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AppEntry {
  name:    string;
  version: string;
  path:    string;
  vendor:  string;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 50 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

interface SPApplicationEntry {
  _name:            string;
  version?:         string;
  path?:            string;
  obtained_from?:   string;
  // system_profiler uses different key names depending on macOS version
  info?:            string;
}

interface SPApplicationsData {
  SPApplicationsDataType: SPApplicationEntry[];
}

const APPLE_SYSTEM_VENDORS = [
  "apple",
  "com.apple",
];

function isSystemApp(entry: SPApplicationEntry): boolean {
  const vendor = (entry.obtained_from ?? "").toLowerCase();
  const name   = (entry._name ?? "").toLowerCase();
  const path   = (entry.path ?? "").toLowerCase();
  return (
    APPLE_SYSTEM_VENDORS.some((v) => vendor.includes(v)) ||
    path.startsWith("/system/") ||
    path.startsWith("/library/apple/")
  ) && !name.includes("xcode"); // keep Xcode as it's developer-relevant
}

async function listInstalledAppsDarwin(
  filter:            string | undefined,
  includeSystemApps: boolean,
): Promise<AppEntry[]> {
  const { stdout } = await execAsync(
    "system_profiler SPApplicationsDataType -json 2>/dev/null",
    { maxBuffer: 50 * 1024 * 1024 },
  );

  const data = JSON.parse(stdout) as SPApplicationsData;
  const apps = data.SPApplicationsDataType ?? [];

  return apps
    .filter((entry) => {
      if (!includeSystemApps && isSystemApp(entry)) return false;
      if (filter) {
        return entry._name.toLowerCase().includes(filter.toLowerCase());
      }
      return true;
    })
    .map((entry) => ({
      name:    entry._name,
      version: entry.version ?? "unknown",
      path:    entry.path    ?? "unknown",
      vendor:  entry.obtained_from ?? "unknown",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// -- win32 implementation -----------------------------------------------------

interface WinPackage {
  Name:    string;
  Version: string;
  Source:  string | null;
}

const MICROSOFT_SYSTEM_PREFIXES = [
  "microsoft windows",
  "windows ",
  "microsoft visual c++",
  "microsoft .net",
];

function isMicrosoftSystemApp(name: string): boolean {
  const lower = name.toLowerCase();
  return MICROSOFT_SYSTEM_PREFIXES.some((p) => lower.startsWith(p));
}

async function listInstalledAppsWin32(
  filter:            string | undefined,
  includeSystemApps: boolean,
): Promise<AppEntry[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-Package | Select-Object Name, Version, Source | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw    = await runPS(ps);
  const parsed = JSON.parse(raw) as WinPackage | WinPackage[];
  const pkgs   = Array.isArray(parsed) ? parsed : [parsed];

  return pkgs
    .filter((pkg) => {
      if (!pkg.Name) return false;
      if (!includeSystemApps && isMicrosoftSystemApp(pkg.Name)) return false;
      if (filter) {
        return pkg.Name.toLowerCase().includes(filter.toLowerCase());
      }
      return true;
    })
    .map((pkg) => ({
      name:    pkg.Name,
      version: pkg.Version ?? "unknown",
      path:    pkg.Source  ?? "unknown",
      vendor:  "unknown",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// -- Exported run function ----------------------------------------------------

export async function run({
  filter,
  includeSystemApps = false,
}: {
  filter?:            string;
  includeSystemApps?: boolean;
} = {}) {
  const platform = os.platform();
  const apps     = platform === "win32"
    ? await listInstalledAppsWin32(filter, includeSystemApps)
    : await listInstalledAppsDarwin(filter, includeSystemApps);

  return {
    platform,
    filter:           filter ?? null,
    includeSystemApps,
    total:            apps.length,
    apps,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ filter: process.argv[2] })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
