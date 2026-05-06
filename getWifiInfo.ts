/**
 * mcp/skills/getWifiInfo.ts — get_wifi_info skill
 *
 * Reports current Wi-Fi connection details: SSID, signal strength (RSSI dBm),
 * channel, band, security type, and link speed.  Use to diagnose Wi-Fi
 * performance or intermittent connectivity.
 *
 * Platform strategy
 * -----------------
 * darwin  Three-step probe (no single command works post-Sequoia):
 *           1. `networksetup -listallhardwareports` — discover the Wi-Fi
 *              device (typically en0 but not guaranteed)
 *           2. `ifconfig <device>` — confirm the interface is UP+RUNNING with
 *              an inet address (the authoritative isConnected signal)
 *           3. `system_profiler SPAirPortDataType` — rich per-network details
 *              (SSID, channel, band, RSSI, security)
 *         The legacy `airport -I` was deprecated in macOS 14.4 and now returns
 *         only a deprecation warning with no key:value data — DO NOT USE.
 *         The SSID is reported as `<redacted>` unless the calling app holds
 *         CoreLocation authorization (NSLocationWhenInUseUsageDescription +
 *         user grant).  When redacted, `ssid` is null and `ssidAvailable` is
 *         false — connectivity reporting is still accurate via ifconfig.
 * win32   PowerShell `netsh wlan show interfaces` — parses text output
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getWifiInfo.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_wifi_info",
  description:
    "Reports current Wi-Fi connection details: SSID, signal strength (RSSI dBm), " +
    "channel, band, security type, and link speed. " +
    "Use to diagnose Wi-Fi performance or intermittent connectivity.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

type LinkQuality = "excellent" | "good" | "fair" | "poor" | "unknown";

interface WifiInfoResult {
  /** OS-level Wi-Fi device name (e.g. "en0").  Resolved at runtime on darwin
   *  via networksetup; null when no Wi-Fi hardware port is found. */
  device:        string | null;
  ssid:          string | null;
  /** False when the OS withholds the SSID — typically because the calling
   *  app lacks CoreLocation authorization on macOS 14.4+.  `isConnected` is
   *  still authoritative and correct in that case; the SSID is just hidden. */
  ssidAvailable: boolean;
  bssid:         string | null;
  rssi:          number | null;
  noise:         number | null;
  snr:           number | null;
  channel:       number | null;
  band:          string | null;
  security:      string | null;
  txRateMbps:    number | null;
  linkQuality:   LinkQuality;
  isConnected:   boolean;
  platform:      string;
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

// -- Helpers ------------------------------------------------------------------

function computeLinkQuality(rssi: number | null): LinkQuality {
  if (rssi === null) return "unknown";
  if (rssi > -50)   return "excellent";
  if (rssi > -60)   return "good";
  if (rssi > -70)   return "fair";
  return "poor";
}

function parseKeyValue(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) map.set(key, value);
  }
  return map;
}

// -- darwin implementation ----------------------------------------------------

/**
 * Discovers the Wi-Fi hardware port's device name (e.g. "en0").
 * On Macs with discrete Wi-Fi cards or unusual configurations the device
 * name may not be en0, so we never hard-code it.  Returns null when no
 * Wi-Fi hardware port exists on this machine.
 */
async function findWifiDeviceDarwin(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("networksetup -listallhardwareports");
    // Output is blocks of three lines separated by blank lines:
    //   Hardware Port: Wi-Fi
    //   Device: en0
    //   Ethernet Address: 84:2f:57:1e:fc:28
    const blocks = stdout.split(/\n\s*\n/);
    for (const block of blocks) {
      const portMatch   = block.match(/Hardware Port:\s*(.+)/);
      const deviceMatch = block.match(/Device:\s*(\S+)/);
      if (portMatch && deviceMatch && portMatch[1].trim() === "Wi-Fi") {
        return deviceMatch[1].trim();
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Authoritative connectivity probe: parses `ifconfig <device>` and reports
 * whether the interface is UP+RUNNING with an inet address.  This works
 * regardless of CoreLocation authorization, so even when the SSID is
 * redacted we can still correctly report `isConnected`.
 */
async function probeWifiLinkDarwin(device: string): Promise<{
  up:    boolean;
  hasIp: boolean;
  ipv4:  string | null;
}> {
  try {
    const { stdout } = await execAsync(`ifconfig '${device}'`);
    const flags = stdout.match(/flags=\S+\s*<([^>]*)>/)?.[1] ?? "";
    const flagSet = new Set(flags.split(","));
    const up = flagSet.has("UP") && flagSet.has("RUNNING");
    const ipv4Match = stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    return { up, hasIp: !!ipv4Match, ipv4: ipv4Match?.[1] ?? null };
  } catch {
    return { up: false, hasIp: false, ipv4: null };
  }
}

interface SystemProfilerWifiInfo {
  ssid:           string | null;
  ssidAvailable:  boolean;
  channel:        number | null;
  band:           string | null;
  rssi:           number | null;
  txRateMbps:     number | null;
  security:       string | null;
}

/**
 * Parses the "Current Network Information" block out of
 * `system_profiler SPAirPortDataType`.  Returns null when the section is
 * absent (no Wi-Fi association at the moment of probe).
 *
 * The SSID line appears as either the network name (when CoreLocation is
 * authorized) or `<redacted>` (when not).  We surface the redaction state
 * via `ssidAvailable: false` so callers can distinguish "really no Wi-Fi"
 * from "Wi-Fi is fine, OS is just hiding the name".
 */
async function getWifiInfoFromSystemProfiler(): Promise<SystemProfilerWifiInfo | null> {
  let output = "";
  try {
    const { stdout } = await execAsync(
      "system_profiler SPAirPortDataType",
      { maxBuffer: 5 * 1024 * 1024, timeout: 10_000 },
    );
    output = stdout;
  } catch {
    return null;
  }

  const idx = output.indexOf("Current Network Information:");
  if (idx === -1) return null;

  const lines = output.slice(idx).split("\n");

  // The SSID is the first non-blank indented line after the header, ending
  // with a colon.  Skip the header itself (lines[0]).
  let ssidLine: string | null = null;
  let ssidLineIdx = -1;
  for (let i = 1; i < lines.length && i < 8; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0) continue;
    if (trimmed.endsWith(":")) {
      ssidLine = trimmed.replace(/:\s*$/, "");
      ssidLineIdx = i;
      break;
    }
  }
  if (!ssidLine || ssidLineIdx === -1) return null;

  const isRedacted     = ssidLine === "<redacted>";
  const ssid           = isRedacted ? null : ssidLine;
  const ssidAvailable  = !isRedacted;

  // Subsequent lines are key:value pairs nested under the SSID.  Collect
  // until we hit a blank line, an unindented line, or another SSID-style
  // header (rare but possible when multiple network interfaces are reported).
  const kv = new Map<string, string>();
  for (let i = ssidLineIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) break;
    if (!/^\s/.test(raw)) break;
    const colonIdx = raw.indexOf(":");
    if (colonIdx === -1) continue;
    const key = raw.slice(0, colonIdx).trim();
    const value = raw.slice(colonIdx + 1).trim();
    if (key && value) kv.set(key, value);
  }

  // Channel example: "136 (5GHz, 80MHz)" or "6 (2GHz, 20MHz)" or just "6"
  let channel: number | null = null;
  let band:    string | null = null;
  const channelRaw = kv.get("Channel");
  if (channelRaw) {
    const m = channelRaw.match(/^(\d+)(?:\s*\(([^)]+)\))?/);
    if (m) {
      channel = parseInt(m[1], 10);
      const bandHint = m[2] ?? "";
      if (bandHint.includes("6GHz"))      band = "6 GHz";
      else if (bandHint.includes("5GHz")) band = "5 GHz";
      else if (bandHint.includes("2GHz") || bandHint.includes("2.4GHz")) band = "2.4 GHz";
      else                                band = channel <= 14 ? "2.4 GHz" : "5 GHz";
    }
  }

  // Signal / Noise example: "-58 dBm / -89 dBm"
  let rssi: number | null = null;
  const signalRaw = kv.get("Signal / Noise");
  if (signalRaw) {
    const m = signalRaw.match(/(-?\d+)\s*dBm/);
    if (m) rssi = parseInt(m[1], 10);
  }

  // Transmit Rate example: "650" or "0.0"
  let txRateMbps: number | null = null;
  const txRaw = kv.get("Transmit Rate") ?? kv.get("Last Tx Rate");
  if (txRaw) {
    const num = parseFloat(txRaw);
    if (!isNaN(num) && num > 0) txRateMbps = num;
  }

  return {
    ssid,
    ssidAvailable,
    channel,
    band,
    rssi,
    txRateMbps,
    security: kv.get("Security") ?? null,
  };
}

async function getWifiInfoDarwin(): Promise<WifiInfoResult> {
  const empty = (device: string | null): WifiInfoResult => ({
    device,
    ssid:          null,
    ssidAvailable: false,
    bssid:         null,
    rssi:          null,
    noise:         null,
    snr:           null,
    channel:       null,
    band:          null,
    security:      null,
    txRateMbps:    null,
    linkQuality:   "unknown",
    isConnected:   false,
    platform:      "darwin",
  });

  const device = await findWifiDeviceDarwin();
  if (!device) return empty(null);

  // Step 1 — authoritative connectivity check.  When the interface is down
  // or has no IP, we know definitively that Wi-Fi is not active and can
  // skip the slower system_profiler call (~1-3s on busy systems).
  const link = await probeWifiLinkDarwin(device);
  if (!link.up || !link.hasIp) return empty(device);

  // Step 2 — interface is up; pull rich details.  system_profiler may fail
  // (privacy permission, transient I/O) — when that happens we still report
  // isConnected: true, just without channel/band/RSSI enrichment.
  const info = await getWifiInfoFromSystemProfiler();

  return {
    device,
    ssid:          info?.ssid ?? null,
    // SSID-available is true only when system_profiler returned a real name.
    // When system_profiler itself failed, we don't know — surface as false
    // (caller should treat as "unable to obtain" rather than "redacted").
    ssidAvailable: info?.ssidAvailable ?? false,
    bssid:         null, // BSSID is also gated behind CoreLocation; not parsed.
    rssi:          info?.rssi ?? null,
    noise:         null, // Not exposed by system_profiler.
    snr:           null,
    channel:       info?.channel ?? null,
    band:          info?.band ?? null,
    security:      info?.security ?? null,
    txRateMbps:    info?.txRateMbps ?? null,
    linkQuality:   computeLinkQuality(info?.rssi ?? null),
    isConnected:   true, // Link is UP+RUNNING with an IP — that's connected.
    platform:      "darwin",
  };
}

// -- win32 implementation -----------------------------------------------------

async function getWifiInfoWin32(): Promise<WifiInfoResult> {
  let output = "";
  try {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
netsh wlan show interfaces`.trim();
    output = await runPS(ps);
  } catch {
    return {
      device: null, ssid: null, ssidAvailable: false, bssid: null,
      rssi: null, noise: null, snr: null,
      channel: null, band: null, security: null, txRateMbps: null,
      linkQuality: "unknown", isConnected: false, platform: "win32",
    };
  }

  const kv = parseKeyValue(output);

  const device   = kv.get("Name") ?? null;
  const ssid     = kv.get("SSID") ?? kv.get("      SSID") ?? null;
  const bssid    = kv.get("BSSID") ?? null;
  const sigStr   = kv.get("Signal");
  const chanStr  = kv.get("Channel");
  const radioType = kv.get("Radio type") ?? null;
  const auth     = kv.get("Authentication") ?? null;
  const rxStr    = kv.get("Receive rate (Mbps)");
  const txStr    = kv.get("Transmit rate (Mbps)");

  // Signal on Windows is 0-100 — convert to approximate RSSI
  let rssi: number | null = null;
  if (sigStr) {
    const sigPct = parseInt(sigStr.replace("%", ""), 10);
    if (!isNaN(sigPct)) {
      // Approximate RSSI from percentage: 100% ~ -50dBm, 0% ~ -100dBm
      rssi = Math.round((sigPct / 2) - 100);
    }
  }

  const channel    = chanStr ? parseInt(chanStr, 10) : null;
  const band       = radioType?.includes("802.11a") || radioType?.includes("802.11n") || radioType?.includes("802.11ac")
    ? (channel && channel > 14 ? "5 GHz" : "2.4 GHz")
    : null;

  const txRateMbps = txStr ? parseFloat(txStr) : (rxStr ? parseFloat(rxStr) : null);
  const isConnected = ssid !== null && ssid !== "";

  return {
    device,
    ssid,
    // Windows netsh does not redact the SSID — its presence is the
    // authoritative signal.  When ssid is null we couldn't read it at all.
    ssidAvailable: ssid !== null,
    bssid,
    rssi,
    noise:      null, // Not available on Windows via netsh
    snr:        null,
    channel:    isNaN(channel ?? NaN) ? null : channel,
    band,
    security:   auth,
    txRateMbps: isNaN(txRateMbps ?? NaN) ? null : txRateMbps,
    linkQuality: computeLinkQuality(rssi),
    isConnected,
    platform: "win32",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? getWifiInfoWin32()
    : getWifiInfoDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
