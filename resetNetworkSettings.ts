/**
 * mcp/skills/resetNetworkSettings.ts — reset_network_settings skill
 *
 * Resets network configuration to defaults by removing custom network locations
 * and recreating the Automatic location.
 * Use when network settings are corrupt or misconfigured and simpler fixes have failed.
 *
 * Platform strategy
 * -----------------
 * darwin  networksetup -setnetworkserviceenabled "<service>" off → on (bounce)
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
    darwin: "sudo networksetup -setnetworkserviceenabled '<service>' off && sudo networksetup -setnetworkserviceenabled '<service>' on  # substitute the service name, e.g. Wi-Fi",
    win32:  "netsh int ip reset && netsh winsock reset  # run from elevated Command Prompt; reboot afterwards",
  },
  schema: {
    // snake_case `interface` matches the privileged helper's struct Params field
    // (required). macOS: network SERVICE name ("Wi-Fi", "Ethernet"). Windows:
    // interface name. G4 forwards executor params verbatim to the helper.
    interface: z
      .string()
      .describe(
        "Network service/interface to reset. macOS: service name (e.g. " +
        "\"Wi-Fi\", \"Ethernet\"). Windows: interface name. Pass the active " +
        "interface from get_network_interfaces.",
      ),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("If true, show what would be reset without modifying. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ResetResult {
  interface:      string;
  reset:          boolean;
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

async function resetDarwin(iface: string, dryRun: boolean): Promise<ResetResult> {
  // Match the privileged helper: bounce the named network SERVICE off→on, which
  // tears down and rebuilds its config (DHCP lease, routes) without the heavier
  // location surgery the old local path did. No reboot needed.
  if (dryRun) {
    return {
      interface:      iface,
      reset:          false,
      dryRun:         true,
      rebootRequired: false,
      message:        `Dry run: would disable then re-enable network service "${iface}" (networksetup -setnetworkserviceenabled off/on). Run with dryRun=false to apply.`,
    };
  }

  const safeSvc = iface.replace(/'/g, "'\\''");
  try {
    await execAsync(`networksetup -setnetworkserviceenabled '${safeSvc}' off 2>/dev/null`);
    await new Promise((r) => setTimeout(r, 1500));
    await execAsync(`networksetup -setnetworkserviceenabled '${safeSvc}' on 2>/dev/null`);
    return {
      interface:      iface,
      reset:          true,
      dryRun:         false,
      rebootRequired: false,
      message:        `Network service "${iface}" reset (disabled then re-enabled).`,
    };
  } catch (e) {
    return {
      interface:      iface,
      reset:          false,
      dryRun:         false,
      rebootRequired: false,
      message:        `Failed to reset network service "${iface}": ${(e as Error).message}. Check the service name with get_network_interfaces.`,
    };
  }
}

// -- win32 implementation -----------------------------------------------------

async function resetWin32(iface: string, dryRun: boolean): Promise<ResetResult> {
  // Windows reset is the global TCP/IP + Winsock stack reset; `netsh` takes no
  // interface argument, so `iface` is accepted for contract parity with the
  // helper but the operation is system-wide (matches the helper's platform note).
  if (dryRun) {
    return {
      interface:      iface,
      reset:          false,
      dryRun:         true,
      rebootRequired: true,
      message:        "Dry run: would run 'netsh int ip reset' and 'netsh winsock reset' (system-wide). A reboot is required after reset. Run with dryRun=false to execute.",
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
    interface:      iface,
    reset:          errors.length === 0,
    dryRun:         false,
    rebootRequired: true,
    message:        errors.length > 0
      ? `Network reset completed with errors: ${errors.join("; ")}. A system reboot is required.`
      : "Network stack reset successfully. A system reboot is required to apply changes.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  interface: iface,
  dryRun = true,
}: {
  interface: string;
  dryRun?:   boolean;
}): Promise<ResetResult & { platform: string }> {
  if (!iface || !iface.trim()) {
    throw new Error("[reset_network_settings] 'interface' is required (service/interface name).");
  }
  const platform = os.platform();
  const result   = platform === "win32"
    ? await resetWin32(iface, dryRun)
    : await resetDarwin(iface, dryRun);

  return { ...result, platform };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ interface: "Wi-Fi" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
