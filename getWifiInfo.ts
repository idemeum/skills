/**
 * mcp/skills/getWifiInfo.ts — get_wifi_info skill
 *
 * Reports current Wi-Fi connection details: SSID, signal strength (RSSI dBm),
 * channel, band, security type, and link speed.  Use to diagnose Wi-Fi
 * performance or intermittent connectivity.
 *
 * Platform strategy
 * -----------------
 * darwin  Probe sequence (no single CLI works post-Sequoia):
 *           1. `networksetup -listallhardwareports` — discover the Wi-Fi
 *              device (typically en0 but not guaranteed)
 *           2. `ifconfig <device>` — confirm the interface is UP+RUNNING with
 *              an inet address (the authoritative isConnected signal)
 *           3. CoreWLAN via JXA (`osascript -l JavaScript`) — PRIMARY signal
 *              source. RSSI / noise / channel / band / txRate / security are
 *              NOT gated behind Location Services, so this returns real signal
 *              data even when the calling app lacks the CoreLocation grant.
 *           4. `system_profiler SPAirPortDataType` — FALLBACK only (used when
 *              the CoreWLAN probe fails to produce an RSSI).
 *         The legacy `airport -I` was deprecated in macOS 14.4 (returns only a
 *         deprecation warning) — DO NOT USE. `system_profiler`'s "Current
 *         Network Information" block (SSID *and* signal) is itself gated behind
 *         CoreLocation on macOS 14+, so relying on it alone returned all-null
 *         signal on machines where the agent lacks the location grant — which
 *         is exactly why CoreWLAN is now primary. SSID / BSSID remain
 *         location-gated on EVERY API; when withheld, `ssid` is null and
 *         `ssidAvailable` is false while RSSI / linkQuality are still accurate.
 * win32   PowerShell `netsh wlan show interfaces` — parses text output
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getWifiInfo.ts
 */

import * as os               from "os";
import { exec, execFile }    from "child_process";
import { promisify }         from "util";
import { z }                 from "zod";

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

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
  outputKeys: ["device","ssid","ssidAvailable","bssid","rssi","noise","snr","channel","band","security","txRateMbps","linkQuality","isConnected","platform"],
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

// CoreWLAN enum → human label maps (stable across macOS versions).
// CWChannelBand: 1=2.4GHz, 2=5GHz, 3=6GHz (0=unknown).
const CW_BAND: Record<number, string> = { 1: "2.4 GHz", 2: "5 GHz", 3: "6 GHz" };
// CWSecurity: the values the field uses in practice; unmapped → null.
const CW_SECURITY: Record<number, string> = {
  0: "None", 1: "WEP",
  2: "WPA Personal", 3: "WPA/WPA2 Personal", 4: "WPA2 Personal",
  6: "WPA Enterprise", 7: "WPA/WPA2 Enterprise", 8: "WPA2 Enterprise",
  10: "WPA3 Personal", 11: "WPA3 Enterprise", 12: "WPA3 Transition",
};

interface CoreWlanWifiInfo {
  ssid:       string | null;
  bssid:      string | null;
  rssi:       number | null;
  noise:      number | null;
  txRateMbps: number | null;
  channel:    number | null;
  band:       string | null;
  security:   string | null;
}

/**
 * PRIMARY darwin signal source. Loads CoreWLAN in-process via JXA and reads the
 * current interface. RSSI / noise / channel / band / txRate / security are NOT
 * gated behind Location Services (verified: returns real values while ssid /
 * bssid come back null without the grant), so this works even when the agent
 * lacks the CoreLocation authorization that `system_profiler` / `airport`
 * require post-macOS 14. Uses execFile (no shell) so the `$` JXA bridge global
 * isn't touched by shell expansion. Returns null if osascript / CoreWLAN fails.
 */
async function getWifiInfoFromCoreWLAN(): Promise<CoreWlanWifiInfo | null> {
  const jxa = `
    ObjC.import('CoreWLAN');
    var i = $.CWWiFiClient.sharedWiFiClient.interface;
    function n(v){ v = (v && v.js !== undefined) ? v.js : v; var x = Number(v); return isNaN(x) ? null : x; }
    function s(v){ return v ? ObjC.unwrap(v) : null; }
    var ch = i.wlanChannel;
    JSON.stringify({
      ssid: s(i.ssid), bssid: s(i.bssid),
      rssi: n(i.rssiValue), noise: n(i.noiseMeasurement), txRate: n(i.transmitRate),
      channel: ch ? n(ch.channelNumber) : null,
      band: ch ? n(ch.channelBand) : null,
      security: n(i.security)
    });
  `.replace(/\n\s*/g, " ").trim();

  try {
    const { stdout } = await execFileAsync(
      "osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 5_000 },
    );
    const r = JSON.parse(stdout.trim()) as {
      ssid: string | null; bssid: string | null;
      rssi: number | null; noise: number | null; txRate: number | null;
      channel: number | null; band: number | null; security: number | null;
    };
    // CoreWLAN reports 0 for rssi/noise/txRate when not associated — treat as null.
    return {
      ssid:       r.ssid || null,
      bssid:      r.bssid || null,
      rssi:       r.rssi  && r.rssi  !== 0 ? r.rssi  : null,
      noise:      r.noise && r.noise !== 0 ? r.noise : null,
      txRateMbps: r.txRate && r.txRate > 0 ? r.txRate : null,
      channel:    r.channel && r.channel > 0 ? r.channel : null,
      band:       r.band != null ? (CW_BAND[r.band] ?? null) : null,
      security:   r.security != null ? (CW_SECURITY[r.security] ?? null) : null,
    };
  } catch {
    return null;
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

  // Step 2 — interface is up; pull rich details. CoreWLAN is primary (signal
  // works without the CoreLocation grant); system_profiler is consulted only as
  // a fallback when CoreWLAN yields no RSSI. Either way isConnected stays true.
  const cw = await getWifiInfoFromCoreWLAN();
  const sp = (!cw || cw.rssi === null) ? await getWifiInfoFromSystemProfiler() : null;

  const rssi   = cw?.rssi  ?? sp?.rssi  ?? null;
  const noise  = cw?.noise ?? null; // only CoreWLAN exposes noise
  const ssid   = cw?.ssid  ?? sp?.ssid ?? null;
  const channel = cw?.channel ?? sp?.channel ?? null;

  return {
    device,
    ssid,
    // We got the SSID iff a real name came back (location-gated on every API).
    ssidAvailable: Boolean(ssid),
    bssid:         cw?.bssid ?? null, // also location-gated; null without the grant
    rssi,
    noise,
    snr:           rssi !== null && noise !== null ? rssi - noise : null,
    channel,
    band:          cw?.band ?? sp?.band
                     ?? (channel !== null ? (channel <= 14 ? "2.4 GHz" : "5 GHz") : null),
    security:      cw?.security ?? sp?.security ?? null,
    txRateMbps:    cw?.txRateMbps ?? sp?.txRateMbps ?? null,
    linkQuality:   computeLinkQuality(rssi),
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
