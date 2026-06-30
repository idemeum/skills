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

import { detectVendorForProfile, WIN32_VPN_VENDOR_PROCS, type VpnVendor } from "./_shared/vpnProfiles";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reconnect_vpn",
  description:
    "Disconnects and reconnects a VPN profile by name. " +
    "Use when a VPN connection is stale, showing connected but not routing traffic, " +
    "or after network changes.",
  riskLevel:       "medium",
  // destructive: dropping the tunnel interrupts active sessions and, on a
  // full-tunnel VPN, briefly cuts the device off the network. Marked true so
  // G4 auto-triggers the dry-run preview (supportsDryRun + destructive) — a
  // medium/non-destructive tool would skip the preview and only show consent.
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["network"],
  auditRequired:   true,
  // `scutil --nc start` is fire-and-forget; the darwin path polls for the
  // tunnel to actually settle to Connected (up to ~25 s) instead of reporting
  // the transient "Connecting" as success. Raise the ceiling above the 60 s
  // default headroom so the disconnect + pause + start + poll chain never races
  // the G4 deadline.
  timeoutMs:       90_000,
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
  /** Set when the profile is a vendor-managed VPN (AnyConnect / GlobalProtect)
   *  that scutil cannot drive — the corrective can't reconnect it and the user
   *  must use the vendor client. Distinct from a genuinely missing profile. */
  vendorManaged?: VpnVendor;
  message?:       string;
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

// -- darwin status helper -----------------------------------------------------

/**
 * Read the current connection state of a native (scutil) profile from
 * `scutil --nc list`. Lines look like:
 *   `* (Connected)    <UUID> ... "ProfileName" [type]`
 *   `  (Disconnected) <UUID> ... "ProfileName" [type]`
 * Returns the state word ("Connected" / "Connecting" / "Disconnected" /
 * "Disconnecting" / "Invalid") or null if the profile/line isn't found.
 */
async function readNativeStatus(profileName: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync("scutil --nc list 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 5_000,
    });
    for (const line of stdout.split("\n")) {
      if (line.includes(`"${profileName}"`)) {
        return line.match(/\((\w+)\)/)?.[1] ?? null;
      }
    }
  } catch { /* ignore */ }
  return null;
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
    // Not a native (scutil) profile. Before declaring it missing, check whether
    // it's a vendor-managed profile that get_vpn_profiles legitimately surfaced —
    // scutil can't list OR drive AnyConnect / GlobalProtect, so reconnecting must
    // happen via the vendor client. Return accurate guidance instead of a
    // misleading "Profile not found".
    const vendor = await detectVendorForProfile(profileName);
    if (vendor) {
      return {
        profileName,
        disconnected: false,
        reconnected:  false,
        dryRun,
        newStatus:    "vendor-managed — not reconnected",
        vendorManaged: vendor,
        message:
          `"${profileName}" is a ${vendor} VPN managed by its own client; ` +
          `macOS scutil cannot reconnect it. Quit and relaunch the ${vendor} ` +
          `app (or use its menu-bar Connect) to re-establish the tunnel.`,
      };
    }
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

  // Reconnect. NOTE: `scutil --nc start` is fire-and-forget — it accepts the
  // request and returns immediately, BEFORE the tunnel is up. A status read here
  // almost always catches the transient "Connecting" state, so we must NOT treat
  // a successful start as a successful reconnect.
  try {
    await execAsync(`scutil --nc start "${safeName}" 2>/dev/null`, {
      maxBuffer: 1 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (err) {
    throw new Error(
      `[reconnect_vpn] Failed to start profile "${profileName}": ${(err as Error).message}`,
    );
  }

  // Poll until the connection settles to Connected (real success), a terminal
  // failure state, or the deadline elapses (still Connecting → stuck). This is
  // what makes "reconnected" mean the tunnel is actually up rather than merely
  // "start was accepted" — and stops the skill from advancing to DNS-flush /
  // routing-verification on a half-established tunnel.
  const DEADLINE_MS = 25_000;
  const POLL_MS     = 1_500;
  const startedAt   = Date.now();
  let newStatus = await readNativeStatus(profileName);
  while (Date.now() - startedAt < DEADLINE_MS) {
    if (newStatus === "Connected") break;                       // success
    if (newStatus === "Disconnected" || newStatus === "Invalid") break; // terminal failure
    await new Promise((res) => setTimeout(res, POLL_MS));
    newStatus = await readNativeStatus(profileName);
  }

  reconnected = newStatus === "Connected";
  const waited = Math.round((Date.now() - startedAt) / 1000);
  const message = reconnected
    ? `VPN profile "${profileName}" reconnected — status: Connected.`
    : newStatus === "Connecting" || newStatus === null
      ? `VPN profile "${profileName}" is still establishing the tunnel (status: ${newStatus ?? "unknown"}) after ${waited}s. ` +
        "It may be waiting on credentials/MFA, a vendor app or system extension, or an unresponsive server. " +
        "Check your VPN client's menu-bar icon and complete any sign-in, or try again."
      : `VPN profile "${profileName}" did not connect — status: ${newStatus}. ` +
        "Toggle Disconnect → Connect from the VPN menu-bar icon, or escalate to IT if it persists.";

  return { profileName, disconnected, reconnected, dryRun: false, newStatus, message };
}

// -- win32 vendor detection ---------------------------------------------------

/**
 * Checks whether a running process matches any known Windows VPN vendor client.
 * Returns the vendor label for the first match, or null if none is found.
 * Used by reconnect_vpn to distinguish "vendor-managed" from "genuinely missing"
 * when Get-VpnConnection doesn't recognise the profile name.
 */
async function detectVendorForProfileWin32(profileName: string): Promise<VpnVendor | null> {
  // First try a name-based match: if the profile name contains the vendor name
  // (e.g. "ProtonVPN Free" → ProtonVPN), trust that before spawning PS.
  const lower = profileName.toLowerCase();
  for (const { label } of WIN32_VPN_VENDOR_PROCS) {
    if (lower.includes(label.toLowerCase().split(" ")[0].toLowerCase())) {
      // Confirm the client is actually installed/running before declaring it vendor-managed.
      const procEntry = WIN32_VPN_VENDOR_PROCS.find((e) => e.label === label);
      if (!procEntry) continue;
      const safeName = procEntry.proc.replace(/'/g, "''");
      try {
        const out = await runPS(
          `if (Get-Process -Name '${safeName}' -ErrorAction SilentlyContinue) { 'running' } else { 'notfound' }`,
        );
        if (out.trim() === "running") return label;
      } catch { /* ignore */ }
    }
  }

  // Fallback: scan all known vendor processes; return the first running one.
  // Covers cases where the profile name doesn't contain the vendor name.
  const procListPs = WIN32_VPN_VENDOR_PROCS
    .map((e) => `[PSCustomObject]@{proc='${e.proc}';label='${e.label}'}`)
    .join(",\n  ");
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$map = @(${procListPs})
foreach ($e in $map) {
  if (Get-Process -Name $e.proc -ErrorAction SilentlyContinue) { $e.label; break }
}`.trim();
  try {
    const out = await runPS(ps);
    const found = out.trim();
    if (found) return found as VpnVendor;
  } catch { /* ignore */ }

  return null;
}

// -- win32 implementation -----------------------------------------------------

async function reconnectVpnWin32(
  profileName: string,
  dryRun: boolean,
): Promise<ReconnectVpnResult> {
  const safeName = profileName.replace(/'/g, "''");

  // Verify profile exists in Windows RAS
  const checkPs = `
$ErrorActionPreference = 'SilentlyContinue'
$c = Get-VpnConnection -Name '${safeName}' -ErrorAction SilentlyContinue
if (-not $c) { $c = Get-VpnConnection -AllUserConnection -Name '${safeName}' -ErrorAction SilentlyContinue }
if ($c) { 'found' } else { 'notfound' }`.trim();

  const checkResult = await runPS(checkPs);
  if (checkResult !== "found") {
    // Not a native RAS profile. Check whether it's a vendor-managed VPN
    // (ProtonVPN, NordVPN, etc.) — return accurate guidance instead of a
    // misleading "Profile not found" (mirrors the darwin detectVendorForProfile path).
    const vendor = await detectVendorForProfileWin32(profileName);
    if (vendor) {
      return {
        profileName,
        disconnected:  false,
        reconnected:   false,
        dryRun,
        newStatus:     "vendor-managed — not reconnected",
        vendorManaged: vendor,
        message:
          `"${profileName}" is managed by ${vendor}, which uses its own tunnel driver ` +
          `(WireGuard/OpenVPN) that Windows cannot reconnect via the built-in VPN stack. ` +
          `Open the ${vendor} app in the system tray, disconnect, wait 5 seconds, ` +
          `then click Connect.`,
      };
    }
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
