/**
 * mcp/skills/renewDhcpLease.ts — renew_dhcp_lease skill
 *
 * Releases the current DHCP IP address and requests a new lease.
 * Use when the device has an incorrect IP, APIPA address (169.254.x.x),
 * or network access was just restored.
 *
 * Platform strategy
 * -----------------
 * darwin  `sudo ipconfig set {iface} DHCP` or ifconfig down/up cycle
 * win32   PowerShell ipconfig /release && ipconfig /renew
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/renewDhcpLease.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "renew_dhcp_lease",
  description:
    "Releases the current DHCP IP address and requests a new lease. " +
    "Use when the device has an incorrect IP, APIPA address (169.254.x.x), " +
    "or network access was just restored.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo ipconfig set en0 DHCP  # substitute the active interface name",
    win32:  "ipconfig /release && ipconfig /renew  # run from elevated Command Prompt",
  },
  schema: {
    interface: z
      .string()
      .optional()
      .describe("Network interface name (e.g. 'en0', 'Wi-Fi'). Omit to renew all active interfaces"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RenewResult {
  interface:   string;
  previousIp:  string | null;
  newIp:       string | null;
  renewed:     boolean;
  message:     string;
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

async function getCurrentIpDarwin(iface: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `ifconfig '${iface.replace(/'/g, "'\\''")}' 2>/dev/null`,
      { timeout: 5_000 },
    );
    const m = stdout.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

async function getActiveInterfacesDarwin(): Promise<string[]> {
  try {
    const { stdout } = await execAsync("ifconfig -l 2>/dev/null", { timeout: 5_000 });
    const all = stdout.trim().split(/\s+/);
    // Only include Ethernet / Wi-Fi interfaces (en0, en1, …).  These are the
    // only interface types that hold DHCP leases on macOS.  VPN tunnels
    // (utun*), virtual bridges (bridge*), and wireless-peer links (awdl*,
    // llw*) do not use DHCP and would stall for the full 15 s timeout each.
    const dhcp = all.filter((n) => /^en\d+$/.test(n));
    return dhcp.length > 0 ? dhcp : ["en0"];
  } catch {
    return ["en0"];
  }
}

// -- darwin implementation ----------------------------------------------------

async function renewDarwin(iface: string | undefined): Promise<RenewResult[]> {
  const interfaces = iface ? [iface] : await getActiveInterfacesDarwin();
  const results: RenewResult[] = [];

  for (const ifName of interfaces) {
    const safeName  = ifName.replace(/'/g, "'\\''");
    const previousIp = await getCurrentIpDarwin(ifName);

    try {
      await execAsync(
        `sudo ipconfig set '${safeName}' DHCP 2>/dev/null`,
        { timeout: 15000 },
      );
      // Allow a moment for lease to be acquired
      await new Promise(r => setTimeout(r, 2000));
      const newIp = await getCurrentIpDarwin(ifName);

      results.push({
        interface:  ifName,
        previousIp,
        newIp,
        renewed:    true,
        message:    newIp
          ? `DHCP lease renewed on ${ifName}. New IP: ${newIp}`
          : `DHCP renewal sent on ${ifName} but no IP assigned yet`,
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      results.push({
        interface:  ifName,
        previousIp,
        newIp:      null,
        renewed:    false,
        message:    `Failed to renew DHCP on ${ifName}: ${msg}`,
      });
    }
  }

  return results;
}

// -- win32 implementation -----------------------------------------------------

async function renewWin32(iface: string | undefined): Promise<RenewResult[]> {
  const adapterFilter = iface ? `"${iface}"` : "*";

  let previousIp: string | null = null;
  try {
    const ps = `(Get-NetIPAddress -InterfaceAlias ${adapterFilter} -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress`;
    previousIp = (await runPS(ps)) || null;
  } catch { /* ignore */ }

  try {
    const releaseCmd = iface
      ? `ipconfig /release "${iface}"`
      : "ipconfig /release";
    const renewCmd = iface
      ? `ipconfig /renew "${iface}"`
      : "ipconfig /renew";

    await execAsync(`${releaseCmd} && ${renewCmd}`, { timeout: 30000 });

    let newIp: string | null = null;
    try {
      const ps2 = `(Get-NetIPAddress -InterfaceAlias ${adapterFilter} -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress`;
      newIp = (await runPS(ps2)) || null;
    } catch { /* ignore */ }

    return [{
      interface:  iface ?? "all",
      previousIp,
      newIp,
      renewed:    true,
      message:    newIp
        ? `DHCP lease renewed. New IP: ${newIp}`
        : "DHCP renewal completed but no IP assigned yet",
    }];
  } catch (err) {
    return [{
      interface:  iface ?? "all",
      previousIp,
      newIp:      null,
      renewed:    false,
      message:    `Failed to renew DHCP: ${(err as Error).message}`,
    }];
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  interface: iface,
}: {
  interface?: string;
} = {}): Promise<{ platform: string; results: RenewResult[] }> {
  const platform = os.platform();
  const results  = platform === "win32"
    ? await renewWin32(iface)
    : await renewDarwin(iface);

  return { platform, results };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
