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
  outputKeys: ["profileName","disconnected","reconnected","dryRun","newStatus","vendorManaged","failureReason","failureDetail","message"],
  schema: {
    profileName: z
      .string()
      .describe("VPN profile name to reconnect (from get_vpn_profiles)"),
    dryRun: z
      .boolean()
      .nullable().optional()
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
  /**
   * Why the reconnect failed, when the OS says. Present only on failure;
   * `"unknown"` when the cause could not be determined — always paired with
   * `failureDetail` so an unclassified failure still carries the raw text.
   *
   * This is what lets a skill branch on the failure instead of running probes
   * beforehand to guess between auth, reachability and certificate causes.
   */
  failureReason?: VpnFailureReason;
  /** The raw OS text the reason was derived from — a RAS line on Windows, a
   *  NetworkExtension log entry on macOS. Null when nothing was readable. */
  failureDetail?: string | null;
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
 * Why a reconnect failed, when the OS says.
 *
 * `newStatus` alone ("Disconnected", "Invalid") says a tunnel is not up but not
 * why, so `vpn-repair` had to run separate probes beforehand to guess between
 * these causes — reachability, certificate expiry, extension approval. Each of
 * those is a plan step, an executor iteration, and a guess the failure itself
 * can answer for free.
 *
 * `unknown` is the honest default and is always paired with `failureDetail`
 * carrying the raw text, so an unclassified failure still reaches the user with
 * something actionable rather than being flattened to "did not connect".
 */
export type VpnFailureReason =
  | "auth"                    // credentials, MFA, disabled account
  | "unreachable"             // server or network path
  | "certificate"             // client or server certificate
  | "no-configuration"        // profile missing or unusable
  | "extension-not-approved"  // macOS system extension pending approval
  | "timeout"                 // still negotiating when the deadline elapsed
  | "unknown";

/**
 * Windows RAS error codes → reason.
 *
 * Deliberately partial: only codes whose meaning is unambiguous are mapped, and
 * anything else falls through to `unknown` with the raw message attached.
 * Guessing at a code is worse than saying so — a wrong reason sends the skill
 * down the wrong branch, which is exactly the failure mode this replaces.
 */
const RAS_CODES: Record<string, VpnFailureReason> = {
  "691": "auth",             // username/password not recognised
  "649": "auth",             // account has no dial-in permission
  "718": "auth",             // timeout waiting for a valid response from server
  "691v": "auth",
  "800": "unreachable",      // unable to establish the VPN connection
  "809": "unreachable",      // no response — commonly a blocked/NAT'd path
  "807": "unreachable",      // connection was terminated
  "13801": "certificate",    // IKE authentication credentials are unacceptable
  "13806": "certificate",    // no valid machine certificate
  "798": "certificate",      // no certificate found for EAP
  "623": "no-configuration", // cannot find the phone book entry
  "703": "no-configuration", // connection needs information not configured
};

/**
 * macOS reason extraction from the NetworkExtension unified log.
 *
 * Best-effort by design. Apple does not document these strings and they change
 * between releases, so every pattern here is conservative and unmatched text
 * yields `unknown` plus the raw line. Verified only that the log is READABLE
 * without elevation; the patterns themselves are untested against real
 * failures on this machine, which has no VPN profile configured.
 */
const NE_PATTERNS: Array<[RegExp, VpnFailureReason]> = [
  [/authentication (?:failed|error)|EAP failure|credentials.{0,20}(?:reject|invalid)/i, "auth"],
  [/certificate.{0,30}(?:expired|invalid|untrusted|not found)|no valid identity/i, "certificate"],
  [/(?:server|peer).{0,20}(?:unreachable|not responding|no response)|connection timed out/i, "unreachable"],
  [/extension.{0,30}(?:not approved|awaiting approval|waiting for user)/i, "extension-not-approved"],
  [/(?:configuration|profile).{0,20}(?:missing|not found|invalid)/i, "no-configuration"],
];

/** Maps a raw failure string to a reason, defaulting to `unknown`. */
export function classifyVpnFailure(raw: string | null | undefined): VpnFailureReason {
  if (!raw) return "unknown";
  const ras = raw.match(/(?:error|Error)\s+(\d{3,5})/)?.[1];
  if (ras && RAS_CODES[ras]) return RAS_CODES[ras]!;
  for (const [pattern, reason] of NE_PATTERNS) {
    if (pattern.test(raw)) return reason;
  }
  return "unknown";
}

/**
 * Reads recent NetworkExtension log entries for a failure reason.
 *
 * Never throws and never blocks the result: a failed or slow `log show` yields
 * null, and the caller reports `unknown` — the same answer it gave before this
 * existed. Runs only on a FAILED reconnect, so the cost is not paid on the
 * common path.
 */
async function readNeFailureDetail(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      "log show --predicate 'subsystem == \"com.apple.networkextension\"' " +
      "--last 2m --style compact 2>/dev/null",
      { maxBuffer: 4 * 1024 * 1024, timeout: 10_000 },
    );
    // Keep only lines that look like a VPN failure; the subsystem is noisy with
    // widget and cache chatter that would drown the signal.
    const line = stdout
      .split("\n")
      .filter((l) => /fail|error|reject|invalid|denied|unreachable|timed out|expired/i.test(l))
      .filter((l) => !/UUID cache|sandbox check/i.test(l))
      .pop();
    return line?.trim() || null;
  } catch {
    return null;
  }
}

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

  // Only on failure: the log read costs ~1s and there is nothing to explain
  // when the tunnel came up. "Connecting" at the deadline is a timeout by
  // definition — the OS never reached a terminal state — so it is classified
  // directly rather than guessed at from the log.
  let failureReason: VpnFailureReason = "unknown";
  let failureDetail: string | null = null;
  if (!reconnected) {
    if (newStatus === "Connecting" || newStatus === null) {
      failureReason = "timeout";
    } else {
      failureDetail = await readNeFailureDetail();
      failureReason = classifyVpnFailure(failureDetail);
    }
  }
  const message = reconnected
    ? `VPN profile "${profileName}" reconnected — status: Connected.`
    : newStatus === "Connecting" || newStatus === null
      ? `VPN profile "${profileName}" is still establishing the tunnel (status: ${newStatus ?? "unknown"}) after ${waited}s. ` +
        "It may be waiting on credentials/MFA, a vendor app or system extension, or an unresponsive server. " +
        "Check your VPN client's menu-bar icon and complete any sign-in, or try again."
      : `VPN profile "${profileName}" did not connect — status: ${newStatus}. ` +
        "Toggle Disconnect → Connect from the VPN menu-bar icon, or escalate to IT if it persists.";

  return {
    profileName, disconnected, reconnected, dryRun: false, newStatus,
    failureReason, failureDetail, message,
  };
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
  # rasdial prints the RAS error number and message on failure. It was piped to
  # Out-Null with the error swallowed, which threw away the only discriminating
  # signal Windows gives — 691 (auth), 809 (unreachable), 13801 (certificate).
  $rasOut = rasdial '${safeName}' 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { $connected = $true }
} catch { $rasOut = $_.Exception.Message }
$status = $null
$c = Get-VpnConnection -Name '${safeName}' -ErrorAction SilentlyContinue
if ($c) { $status = $c.ConnectionStatus }
[PSCustomObject]@{ reconnected = $connected; status = $status; rasOut = $rasOut } |
  ConvertTo-Json -Compress`.trim();

  const raw = await runPS(ps);
  let parsed: { reconnected: boolean; status: string | null; rasOut?: string | null } = {
    reconnected: false,
    status:      null,
  };
  try {
    parsed = JSON.parse(raw);
  } catch { /* ignore */ }

  const failureDetail = parsed.reconnected ? null : (parsed.rasOut?.trim() || null);

  return {
    profileName,
    disconnected: true,
    reconnected:  parsed.reconnected,
    dryRun:       false,
    newStatus:    parsed.status,
    failureReason: parsed.reconnected ? "unknown" : classifyVpnFailure(failureDetail),
    failureDetail,
    message: parsed.reconnected
      ? `VPN profile "${profileName}" reconnected — status: ${parsed.status ?? "Connected"}.`
      : `VPN profile "${profileName}" did not connect${parsed.status ? ` — status: ${parsed.status}` : ""}.` +
        (failureDetail ? ` ${failureDetail}` : ""),
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
