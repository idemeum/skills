/**
 * mcp/skills/getStartupItems.ts — get_startup_items skill
 *
 * Lists all applications and agents that launch automatically at login.
 * Includes login items, launch agents, and launch daemons.
 *
 * Platform strategy
 * -----------------
 * darwin  osascript for login items; scan LaunchAgents / LaunchDaemons dirs
 * win32   PowerShell Win32_StartupCommand + registry Run keys
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getStartupItems.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";
import * as fs       from "fs/promises";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_startup_items",
  description:
    "Lists all applications and agents that launch automatically at login. " +
    "Includes login items, launch agents, and launch daemons. Use when " +
    "diagnosing slow boot times or identifying unwanted startup programs.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess", "Automation"],
  schema: {
    includeSystem: z
      .boolean()
      .optional()
      .describe("Include Apple system agents. Default: false"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface StartupItem {
  name: string;
  path: string;
  type: "login-item" | "launch-agent" | "launch-daemon" | "registry" | "startup-command";
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

// -- darwin helpers -----------------------------------------------------------

const APPLE_PREFIXES = ["com.apple.", "com.osquery.", "com.openssh."];

function isAppleItem(name: string): boolean {
  const lower = name.toLowerCase();
  return APPLE_PREFIXES.some(p => lower.startsWith(p));
}

async function scanPlistDir(
  dir:           string,
  type:          StartupItem["type"],
  includeSystem: boolean,
): Promise<StartupItem[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter(e => e.endsWith(".plist"))
      .filter(e => includeSystem || !isAppleItem(e.replace(/\.plist$/, "")))
      .map(e => ({
        name: e.replace(/\.plist$/, ""),
        path: nodePath.join(dir, e),
        type,
      }));
  } catch {
    return [];
  }
}

async function getStartupItemsDarwin(includeSystem: boolean): Promise<StartupItem[]> {
  const items: StartupItem[] = [];

  // Login items via osascript
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null`,
      { maxBuffer: 1024 * 1024 },
    );
    const names = stdout.trim();
    if (names) {
      for (const n of names.split(", ").map(s => s.trim()).filter(Boolean)) {
        if (includeSystem || !isAppleItem(n)) {
          items.push({ name: n, path: "", type: "login-item" });
        }
      }
    }
  } catch {
    // osascript may be unavailable or restricted
  }

  const home = os.homedir();

  // User LaunchAgents
  const userAgents = await scanPlistDir(
    nodePath.join(home, "Library", "LaunchAgents"),
    "launch-agent",
    includeSystem,
  );
  items.push(...userAgents);

  // System LaunchAgents
  const sysAgents = await scanPlistDir(
    "/Library/LaunchAgents",
    "launch-agent",
    includeSystem,
  );
  items.push(...sysAgents);

  // System LaunchDaemons
  const daemons = await scanPlistDir(
    "/Library/LaunchDaemons",
    "launch-daemon",
    includeSystem,
  );
  items.push(...daemons);

  return items;
}

// -- win32 implementation -----------------------------------------------------

async function getStartupItemsWin32(): Promise<StartupItem[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$results = @()
$wmi = Get-CimInstance Win32_StartupCommand | ForEach-Object {
  @{ name=$_.Name; path=$_.Command; type='startup-command' }
}
if ($wmi) { $results += $wmi }
$regPaths = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
)
foreach ($rp in $regPaths) {
  $key = Get-ItemProperty -Path $rp -ErrorAction SilentlyContinue
  if ($key) {
    $key.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object {
      $results += @{ name=$_.Name; path=[string]$_.Value; type='registry' }
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as StartupItem | StartupItem[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

// -- Exported run function ----------------------------------------------------

export async function run({
  includeSystem = false,
}: {
  includeSystem?: boolean;
} = {}) {
  const platform  = os.platform();
  const loginItems = platform === "win32"
    ? await getStartupItemsWin32()
    : await getStartupItemsDarwin(includeSystem);

  return {
    platform,
    includeSystem,
    loginItems,
    total: loginItems.length,
  };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
