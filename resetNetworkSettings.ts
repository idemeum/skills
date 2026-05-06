/**
 * mcp/skills/resetNetworkSettings.ts — reset_network_settings skill
 *
 * Resets network configuration to defaults by removing custom network locations
 * and recreating the Automatic location.
 * Use when network settings are corrupt or misconfigured and simpler fixes have failed.
 *
 * Platform strategy
 * -----------------
 * darwin  networksetup -listnetworkserviceorder / -deletelocation
 * win32   PowerShell netsh int ip reset && netsh winsock reset (reboot required)
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/resetNetworkSettings.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reset_network_settings",
  description:
    "Resets network configuration to defaults by removing custom network locations " +
    "and recreating the Automatic location. " +
    "Use when network settings are corrupt or misconfigured and simpler fixes have failed.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo networksetup -deletelocation Automatic && sudo networksetup -createlocation Automatic populate && sudo networksetup -switchtolocation Automatic",
    win32:  "netsh int ip reset && netsh winsock reset  # run from elevated Command Prompt; reboot afterwards",
  },
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, show current network locations without modifying. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ResetResult {
  locations:      string[];
  removed:        string[];
  dryRun:         boolean;
  rebootRequired: boolean;
  message:        string;
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

async function resetDarwin(dryRun: boolean): Promise<ResetResult> {
  // List current network locations
  let locations: string[] = [];
  try {
    const { stdout } = await execAsync("networksetup -listlocations 2>/dev/null");
    locations = stdout.trim().split("\n").filter(Boolean);
  } catch {
    locations = [];
  }

  const customLocations = locations.filter(l => l.toLowerCase() !== "automatic");

  if (dryRun) {
    return {
      locations,
      removed:        [],
      dryRun:         true,
      rebootRequired: false,
      message:        `Found ${locations.length} network location(s). Custom locations: ${customLocations.join(", ") || "none"}. Run with dryRun=false to remove custom locations.`,
    };
  }

  // Remove custom locations (keep "Automatic")
  const removed: string[] = [];
  for (const loc of customLocations) {
    try {
      const safeLoc = loc.replace(/'/g, "'\\''");
      await execAsync(`networksetup -deletelocation '${safeLoc}' 2>/dev/null`);
      removed.push(loc);
    } catch { /* continue */ }
  }

  // Ensure "Automatic" exists
  if (!locations.map(l => l.toLowerCase()).includes("automatic")) {
    try {
      await execAsync("networksetup -createlocation Automatic populate 2>/dev/null");
      await execAsync("networksetup -switchlocation Automatic 2>/dev/null");
    } catch { /* ignore */ }
  } else {
    try {
      await execAsync("networksetup -switchlocation Automatic 2>/dev/null");
    } catch { /* ignore */ }
  }

  return {
    locations,
    removed,
    dryRun:         false,
    rebootRequired: false,
    message:        removed.length > 0
      ? `Removed ${removed.length} custom location(s): ${removed.join(", ")}. Switched to Automatic location.`
      : "No custom locations to remove. Switched to Automatic location.",
  };
}

// -- win32 implementation -----------------------------------------------------

async function resetWin32(dryRun: boolean): Promise<ResetResult> {
  // Get current config info
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
@{
  adapters = (Get-NetAdapter | Select-Object -ExpandProperty Name)
} | ConvertTo-Json -Compress`.trim();

  let adapters: string[] = [];
  try {
    const raw     = await runPS(ps);
    const parsed  = JSON.parse(raw) as { adapters: string[] };
    adapters = parsed.adapters ?? [];
  } catch { /* ignore */ }

  if (dryRun) {
    return {
      locations:      adapters,
      removed:        [],
      dryRun:         true,
      rebootRequired: true,
      message:        "Dry run: would run 'netsh int ip reset' and 'netsh winsock reset'. A reboot is required after reset. Run with dryRun=false to execute.",
    };
  }

  const errors: string[] = [];
  try {
    await execAsync("netsh int ip reset 2>&1", { timeout: 30000 });
  } catch (e) { errors.push(`ip reset: ${(e as Error).message}`); }

  try {
    await execAsync("netsh winsock reset 2>&1", { timeout: 30000 });
  } catch (e) { errors.push(`winsock reset: ${(e as Error).message}`); }

  return {
    locations:      adapters,
    removed:        [],
    dryRun:         false,
    rebootRequired: true,
    message:        errors.length > 0
      ? `Network reset completed with errors: ${errors.join("; ")}. A system reboot is required.`
      : "Network stack reset successfully. A system reboot is required to apply changes.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}): Promise<ResetResult & { platform: string }> {
  const platform = os.platform();
  const result   = platform === "win32"
    ? await resetWin32(dryRun)
    : await resetDarwin(dryRun);

  return { ...result, platform };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
