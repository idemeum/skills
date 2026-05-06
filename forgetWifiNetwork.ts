/**
 * mcp/skills/forgetWifiNetwork.ts — forget_wifi_network skill
 *
 * Removes a saved Wi-Fi network from the preferred networks list so the
 * device no longer auto-connects to it.  Use when a network has changed
 * credentials or causes connection problems.
 *
 * Platform strategy
 * -----------------
 * darwin  `networksetup -listpreferredwirelessnetworks` to check;
 *         `networksetup -removepreferredwirelessnetwork {iface} {ssid}` to remove
 * win32   `netsh wlan show profiles` to check;
 *         `netsh wlan delete profile name="{ssid}"` to remove
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/forgetWifiNetwork.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "forget_wifi_network",
  description:
    "Removes a saved Wi-Fi network from the preferred networks list so the " +
    "device no longer auto-connects to it. " +
    "Use when a network has changed credentials or causes connection problems.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo networksetup -removepreferredwirelessnetwork en0 \"<SSID>\"",
    win32:  "netsh wlan delete profile name=\"<SSID>\"  # run from elevated Command Prompt",
  },
  schema: {
    ssid: z
      .string()
      .describe("Network name (SSID) to forget"),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, check if network is in saved list without removing. Default: true",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ForgetWifiResult {
  ssid:       string;
  interface:  string | null;
  found:      boolean;
  forgotten:  boolean;
  dryRun:     boolean;
  message:    string;
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

async function forgetWifiNetworkDarwin(
  ssid:   string,
  dryRun: boolean,
): Promise<ForgetWifiResult> {
  // Find Wi-Fi interface name
  let wifiInterface: string | null = null;
  try {
    const { stdout } = await execAsync("networksetup -listallhardwareports");
    const lines    = stdout.split("\n");
    let nextIsPort = false;
    for (const line of lines) {
      if (line.includes("Hardware Port: Wi-Fi") || line.includes("Hardware Port: AirPort")) {
        nextIsPort = true;
        continue;
      }
      if (nextIsPort && line.includes("Device:")) {
        wifiInterface = line.replace("Device:", "").trim();
        break;
      }
      if (nextIsPort && !line.trim()) {
        nextIsPort = false;
      }
    }
  } catch { /* fallback */ }

  // Default to en0 if detection failed
  if (!wifiInterface) wifiInterface = "en0";

  // List preferred networks
  let found = false;
  try {
    const { stdout } = await execAsync(
      `networksetup -listpreferredwirelessnetworks '${wifiInterface.replace(/'/g, "'\\''")}'`,
    );
    const lines = stdout.split("\n").map((l) => l.trim());
    found = lines.some((l) => l === ssid);
  } catch { /* ignore */ }

  let forgotten = false;
  if (!dryRun && found) {
    try {
      await execAsync(
        `networksetup -removepreferredwirelessnetwork '${wifiInterface.replace(/'/g, "'\\''")}' '${ssid.replace(/'/g, "'\\''")}'`,
      );
      forgotten = true;
    } catch {
      forgotten = false;
    }
  }

  const message = dryRun
    ? found
      ? `Network "${ssid}" is in the saved networks list on interface ${wifiInterface}. Run with dryRun=false to remove it.`
      : `Network "${ssid}" was not found in the saved networks list on interface ${wifiInterface}.`
    : forgotten
      ? `Network "${ssid}" has been removed from saved networks on interface ${wifiInterface}.`
      : found
        ? `Failed to remove "${ssid}". You may need administrator privileges.`
        : `Network "${ssid}" was not in the saved list — nothing to remove.`;

  return { ssid, interface: wifiInterface, found, forgotten, dryRun, message };
}

// -- win32 implementation -----------------------------------------------------

async function forgetWifiNetworkWin32(
  ssid:   string,
  dryRun: boolean,
): Promise<ForgetWifiResult> {
  // List saved profiles
  let found = false;
  try {
    const raw = await runPS(`
$ErrorActionPreference = 'SilentlyContinue'
netsh wlan show profiles`.trim());
    const lines = raw.split("\n");
    found = lines.some((l) => {
      const match = l.match(/All User Profile\s*:\s*(.+)/i);
      return match ? match[1].trim() === ssid : false;
    });
  } catch { /* ignore */ }

  let forgotten = false;
  if (!dryRun && found) {
    try {
      await runPS(`netsh wlan delete profile name='${ssid.replace(/'/g, "''")}'`);
      forgotten = true;
    } catch {
      forgotten = false;
    }
  }

  const message = dryRun
    ? found
      ? `Network "${ssid}" is in the saved profiles. Run with dryRun=false to remove it.`
      : `Network "${ssid}" was not found in saved Wi-Fi profiles.`
    : forgotten
      ? `Network "${ssid}" has been removed from saved Wi-Fi profiles.`
      : found
        ? `Failed to remove "${ssid}". You may need administrator privileges.`
        : `Network "${ssid}" was not in the saved list — nothing to remove.`;

  return { ssid, interface: null, found, forgotten, dryRun, message };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  ssid,
  dryRun = true,
}: {
  ssid:    string;
  dryRun?: boolean;
}) {
  const platform = os.platform();
  return platform === "win32"
    ? forgetWifiNetworkWin32(ssid, dryRun)
    : forgetWifiNetworkDarwin(ssid, dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ ssid: "MyNetwork" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
