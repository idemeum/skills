/**
 * mcp/skills/getNetworkInterfaces.ts — get_network_interfaces skill
 *
 * Lists all network interfaces with their status, IP addresses, MAC addresses,
 * and connection type (Wi-Fi, Ethernet, VPN, loopback).
 *
 * Platform strategy
 * -----------------
 * darwin  `ifconfig -a` — parse each interface block for inet, ether, status, flags
 * win32   PowerShell Get-NetIPAddress | Select-Object ... | ConvertTo-Json
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getNetworkInterfaces.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_network_interfaces",
  description:
    "Lists all network interfaces with their status, IP addresses, MAC addresses, " +
    "and connection type (Wi-Fi, Ethernet, VPN, loopback). " +
    "Use at the start of any network troubleshooting workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    includeInactive: z
      .boolean()
      .optional()
      .describe("Include inactive/disconnected interfaces. Default: false"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface NetworkInterface {
  name:   string;
  type:   "Wi-Fi" | "Ethernet" | "VPN" | "Loopback" | "Other";
  status: "active" | "inactive";
  ipv4:   string | null;
  ipv6:   string | null;
  mac:    string | null;
  mtu:    number | null;
}

interface RunResult {
  platform:    string;
  interfaces:  NetworkInterface[];
  activeCount: number;
  total:       number;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

/**
 * Resolves device → hardware-port-type by parsing
 * `networksetup -listallhardwareports`.  This is the only reliable way on
 * darwin: en0 is *usually* Wi-Fi but Macs with discrete Wi-Fi cards or
 * non-default configurations break that assumption.  Returns an empty Map
 * when networksetup fails — the caller falls back to name-prefix heuristics.
 */
async function getDeviceTypeMapDarwin(): Promise<Map<string, NetworkInterface["type"]>> {
  const map = new Map<string, NetworkInterface["type"]>();
  try {
    const { stdout } = await execAsync("networksetup -listallhardwareports");
    const blocks = stdout.split(/\n\s*\n/);
    for (const block of blocks) {
      const portMatch   = block.match(/Hardware Port:\s*(.+)/);
      const deviceMatch = block.match(/Device:\s*(\S+)/);
      if (!portMatch || !deviceMatch) continue;
      const port   = portMatch[1].trim();
      const device = deviceMatch[1].trim();
      if (port === "Wi-Fi")                          map.set(device, "Wi-Fi");
      else if (port.toLowerCase().includes("ethernet")) map.set(device, "Ethernet");
      else if (port.toLowerCase().includes("thunderbolt")) map.set(device, "Ethernet");
    }
  } catch {
    /* fall through — caller heuristic handles missing entries */
  }
  return map;
}

function classifyInterface(
  name:          string,
  deviceTypeMap: Map<string, NetworkInterface["type"]>,
): NetworkInterface["type"] {
  if (name === "lo0") return "Loopback";
  if (name.startsWith("utun") || name.startsWith("ipsec") || name.startsWith("tun")) return "VPN";
  // Authoritative source: networksetup hardware-port mapping.
  const fromMap = deviceTypeMap.get(name);
  if (fromMap) return fromMap;
  // Fallback heuristic for interfaces networksetup doesn't enumerate
  // (transient bridges, VM adapters): treat anything starting with "en"
  // generically as Ethernet rather than guessing Wi-Fi from the device name.
  if (name.startsWith("en")) return "Ethernet";
  return "Other";
}

async function getInterfacesDarwin(includeInactive: boolean): Promise<NetworkInterface[]> {
  const [ifconfigResult, deviceTypeMap] = await Promise.all([
    execAsync("ifconfig -a", { maxBuffer: 10 * 1024 * 1024 }),
    getDeviceTypeMapDarwin(),
  ]);
  const { stdout } = ifconfigResult;

  const blocks = stdout.split(/^(?=\S)/m).filter(Boolean);
  const result: NetworkInterface[] = [];

  for (const block of blocks) {
    const nameMatch = block.match(/^(\S+?):/);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    const flags   = block.match(/flags=\S+\s*<([^>]*)>/)?.[1] ?? "";
    const isUp    = flags.split(",").includes("UP");
    const status: NetworkInterface["status"] = isUp ? "active" : "inactive";

    if (!includeInactive && status === "inactive") continue;

    const ipv4Match = block.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    const ipv6Match = block.match(/inet6 ([a-f0-9:]+)/);
    const macMatch  = block.match(/ether ([0-9a-f:]{17})/i);
    const mtuMatch  = block.match(/mtu (\d+)/);

    result.push({
      name,
      type:   classifyInterface(name, deviceTypeMap),
      status,
      ipv4:   ipv4Match?.[1] ?? null,
      ipv6:   ipv6Match?.[1] ?? null,
      mac:    macMatch?.[1]  ?? null,
      mtu:    mtuMatch ? parseInt(mtuMatch[1], 10) : null,
    });
  }

  return result;
}

// -- win32 implementation -----------------------------------------------------

async function getInterfacesWin32(includeInactive: boolean): Promise<NetworkInterface[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$addrs = Get-NetIPAddress | Select-Object InterfaceAlias,IPAddress,AddressFamily,PrefixLength
$addrs | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return [];

  interface WinAddr {
    InterfaceAlias:  string;
    IPAddress:       string;
    AddressFamily:   number; // 2=IPv4, 23=IPv6
    PrefixLength:    number;
  }

  const parsed = JSON.parse(raw) as WinAddr | WinAddr[];
  const addrs  = Array.isArray(parsed) ? parsed : [parsed];

  // Group by interface alias
  const map = new Map<string, NetworkInterface>();
  for (const a of addrs) {
    if (!map.has(a.InterfaceAlias)) {
      const name = a.InterfaceAlias;
      let type: NetworkInterface["type"] = "Other";
      if (name.toLowerCase().includes("loopback")) type = "Loopback";
      else if (name.toLowerCase().includes("wi-fi") || name.toLowerCase().includes("wireless")) type = "Wi-Fi";
      else if (name.toLowerCase().includes("ethernet")) type = "Ethernet";
      else if (name.toLowerCase().includes("vpn") || name.toLowerCase().includes("tunnel")) type = "VPN";

      map.set(name, { name, type, status: "active", ipv4: null, ipv6: null, mac: null, mtu: null });
    }
    const entry = map.get(a.InterfaceAlias)!;
    if (a.AddressFamily === 2)  entry.ipv4 = a.IPAddress;
    if (a.AddressFamily === 23) entry.ipv6 = a.IPAddress;
  }

  const all = Array.from(map.values());
  return includeInactive ? all : all.filter(i => i.status === "active");
}

// -- Exported run function ----------------------------------------------------

export async function run({
  includeInactive = false,
}: {
  includeInactive?: boolean;
} = {}): Promise<RunResult> {
  const platform   = os.platform();
  const interfaces = platform === "win32"
    ? await getInterfacesWin32(includeInactive)
    : await getInterfacesDarwin(includeInactive);

  return {
    platform,
    interfaces,
    activeCount: interfaces.filter(i => i.status === "active").length,
    total:       interfaces.length,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
