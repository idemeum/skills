/**
 * mcp/skills/reconnectVpn.ts — reconnect_vpn skill
 *
 * Disconnects and reconnects a VPN profile by name. Use when a VPN connection
 * is stale, showing connected but not routing traffic, or after network changes.
 *
 * Platform strategy
 * -----------------
 * darwin  `scutil --nc stop` then `scutil --nc start` for the named profile
 * win32   PowerShell Disconnect-VpnConnection then Connect-VpnConnection
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/reconnectVpn.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reconnect_vpn",
  description:
    "Disconnects and reconnects a VPN profile by name. " +
    "Use when a VPN connection is stale, showing connected but not routing traffic, " +
    "or after network changes.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  true,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  schema: {
    profileName: z
      .string()
      .describe("VPN profile name to reconnect (from get_vpn_profiles)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, show what would happen without reconnecting. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ReconnectVpnResult {
  profileName:  string;
  disconnected: boolean;
  reconnected:  boolean;
  dryRun:       boolean;
  newStatus:    string | null;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function reconnectVpnDarwin(
  profileName: string,
  dryRun: boolean,
): Promise<ReconnectVpnResult> {
  // Verify profile exists
  let profileExists = false;
  try {
    const { stdout } = await execAsync("scutil --nc list 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5_000,
    });
    profileExists = stdout.includes(`"${profileName}"`);
  } catch { /* ignore */ }

  if (!profileExists) {
    throw new Error(
      `[reconnect_vpn] Profile not found: "${profileName}". ` +
      "Use get_vpn_profiles to list available profiles.",
    );
  }

  if (dryRun) {
    return {
      profileName,
      disconnected: false,
      reconnected:  false,
      dryRun:       true,
      newStatus:    "DryRun — no changes made",
    };
  }

  const safeName = profileName.replace(/"/g, '\\"');
  let disconnected = false;
  let reconnected  = false;

  // Disconnect
  try {
    await execAsync(`scutil --nc stop "${safeName}" 2>/dev/null`, {
      maxBuffer: 1 * 1024 * 1024,
      timeout: 15_000,
    });
    disconnected = true;
  } catch { /* may not be connected */ }

  // Brief pause to allow teardown
  await new Promise((res) => setTimeout(res, 2000));

  // Reconnect
  try {
    await execAsync(`scutil --nc start "${safeName}" 2>/dev/null`, {
      maxBuffer: 1 * 1024 * 1024,
      timeout: 30_000,
    });
    reconnected = true;
  } catch (err) {
    throw new Error(
      `[reconnect_vpn] Failed to start profile "${profileName}": ${(err as Error).message}`,
    );
  }

  // Check new status
  let newStatus: string | null = null;
  try {
    const { stdout } = await execAsync("scutil --nc list 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5_000,
    });
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.includes(`"${profileName}"`)) {
        const match = line.match(/\((\w+)\)/);
        if (match) newStatus = match[1];
        break;
      }
    }
  } catch { /* ignore */ }

  return { profileName, disconnected, reconnected, dryRun: false, newStatus };
}

// -- win32 implementation -----------------------------------------------------

async function reconnectVpnWin32(
  profileName: string,
  dryRun: boolean,
): Promise<ReconnectVpnResult> {
  const safeName = profileName.replace(/'/g, "''");

  // Verify profile exists
  const checkPs = `
$ErrorActionPreference = 'SilentlyContinue'
$c = Get-VpnConnection -Name '${safeName}' -ErrorAction SilentlyContinue
if (-not $c) { $c = Get-VpnConnection -AllUserConnection -Name '${safeName}' -ErrorAction SilentlyContinue }
if ($c) { 'found' } else { 'notfound' }`.trim();

  const checkResult = await runPS(checkPs);
  if (checkResult !== "found") {
    throw new Error(
      `[reconnect_vpn] Profile not found: "${profileName}". ` +
      "Use get_vpn_profiles to list available profiles.",
    );
  }

  if (dryRun) {
    return {
      profileName,
      disconnected: false,
      reconnected:  false,
      dryRun:       true,
      newStatus:    "DryRun — no changes made",
    };
  }

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
try { Disconnect-VpnConnection -Name '${safeName}' -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Seconds 2
$connected = $false
try {
  rasdial '${safeName}' | Out-Null
  $connected = $true
} catch {}
$status = $null
$c = Get-VpnConnection -Name '${safeName}' -ErrorAction SilentlyContinue
if ($c) { $status = $c.ConnectionStatus }
[PSCustomObject]@{ reconnected = $connected; status = $status } |
  ConvertTo-Json -Compress`.trim();

  const raw = await runPS(ps);
  let parsed: { reconnected: boolean; status: string | null } = {
    reconnected: false,
    status:      null,
  };
  try {
    parsed = JSON.parse(raw);
  } catch { /* ignore */ }

  return {
    profileName,
    disconnected: true,
    reconnected:  parsed.reconnected,
    dryRun:       false,
    newStatus:    parsed.status,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  profileName,
  dryRun = true,
}: {
  profileName: string;
  dryRun?:     boolean;
}): Promise<ReconnectVpnResult> {
  if (!profileName || profileName.trim() === "") {
    throw new Error("[reconnect_vpn] profileName is required.");
  }

  const platform = os.platform();
  return platform === "win32"
    ? reconnectVpnWin32(profileName, dryRun)
    : reconnectVpnDarwin(profileName, dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({} as { profileName: string })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
