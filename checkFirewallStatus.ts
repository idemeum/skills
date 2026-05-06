/**
 * mcp/skills/checkFirewallStatus.ts — check_firewall_status skill
 *
 * Reports the current state of the operating system firewall. Useful during
 * security compliance checks, network troubleshooting, or when verifying
 * security agent health.
 *
 * Platform strategy
 * -----------------
 * darwin  ApplicationFirewall socketfilterfw CLI flags
 * win32   PowerShell Get-NetFirewallProfile | ConvertTo-Json
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkFirewallStatus.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_firewall_status",
  description:
    "Reports the current state of the operating system firewall. " +
    "Use during security compliance checks, network troubleshooting, or when " +
    "verifying security agent health.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

interface WinFirewallProfile {
  Name:    string;
  Enabled: boolean;
}

interface FirewallResult {
  platform:            string;
  enabled:             boolean;
  stealthMode:         boolean;
  blockAllConnections: boolean;
  profiles?:           WinFirewallProfile[];
  error?:              string;
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

const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

async function queryFirewallFlag(flag: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`${SOCKETFILTERFW} ${flag} 2>&1`);
    // Output is like "Firewall is enabled. (State = 1)"
    // or "Block all INCOMING connections mode disabled! (State = 0)"
    return /State\s*=\s*1/.test(stdout) || /\benabled\b/i.test(stdout);
  } catch {
    return false;
  }
}

async function checkFirewallDarwin(): Promise<FirewallResult> {
  const [enabled, stealthMode, blockAllConnections] = await Promise.all([
    queryFirewallFlag("--getglobalstate"),
    queryFirewallFlag("--getstealthmode"),
    queryFirewallFlag("--getblockall"),
  ]);

  return {
    platform: "darwin",
    enabled,
    stealthMode,
    blockAllConnections,
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkFirewallWin32(): Promise<FirewallResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-NetFirewallProfile | Select-Object Name, Enabled | ConvertTo-Json -Depth 2 -Compress`.trim();

  try {
    const raw     = await runPS(ps);
    const parsed  = JSON.parse(raw) as WinFirewallProfile | WinFirewallProfile[];
    const profiles = Array.isArray(parsed) ? parsed : [parsed];

    const anyEnabled = profiles.some((p) => p.Enabled === true);

    return {
      platform:            "win32",
      enabled:             anyEnabled,
      stealthMode:         false, // Windows uses different concept (stealth is per-rule)
      blockAllConnections: false, // Not a single toggle in Windows; per-profile
      profiles,
    };
  } catch (err) {
    return {
      platform:            "win32",
      enabled:             false,
      stealthMode:         false,
      blockAllConnections: false,
      error:               (err as Error).message,
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {} as Record<string, never>) {
  const platform = os.platform();
  return platform === "win32"
    ? checkFirewallWin32()
    : checkFirewallDarwin();
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
