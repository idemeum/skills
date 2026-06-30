/**
 * mcp/skills/checkVpnStatus.ts — check_vpn_status skill
 *
 * Reports active VPN connections, interface status, and assigned IP addresses.
 * Detects common VPN clients (built-in macOS VPN, Cisco AnyConnect, GlobalProtect,
 * Pulse Secure, Cloudflare WARP).
 *
 * Platform strategy
 * -----------------
 * darwin  `ifconfig` for VPN interfaces (utun/ppp), `scutil --nc list` for
 *         configured connections, `ps aux` to detect running VPN client processes
 * win32   PowerShell Get-VpnConnection and Get-NetAdapter filtering for VPN/Tunnel
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkVpnStatus.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

import { WIN32_VPN_VENDOR_PROCS } from "./_shared/vpnProfiles";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_vpn_status",
  description:
    "Reports active VPN connections, interface status, and assigned IP addresses. " +
    "Detects common VPN clients (built-in macOS VPN, Cisco AnyConnect, GlobalProtect, " +
    "Pulse Secure, Cloudflare WARP). " +
    "Use at the start of any VPN troubleshooting workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["network"],
  auditRequired:   false,
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

interface VpnConnection {
  name:       string;
  type:       string;
  interface:  string;
  assignedIp: string | null;
  status:     string;
}

interface VpnStatusResult {
  isConnected:        boolean;
  activeConnections:  VpnConnection[];
  installedClients:   string[];
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

async function checkVpnStatusDarwin(): Promise<VpnStatusResult> {
  const connections: VpnConnection[] = [];
  const installedClients: string[] = [];

  // Get VPN interfaces from ifconfig
  let ifconfigOut = "";
  try {
    ({ stdout: ifconfigOut } = await execAsync(
      "ifconfig 2>/dev/null | grep -E -A 4 '^(utun|ppp)'",
      { maxBuffer: 5 * 1024 * 1024, shell: "/bin/bash" },
    ));
  } catch (err) {
    ifconfigOut = (err as { stdout?: string }).stdout ?? "";
  }

  // Parse interfaces from ifconfig
  const interfaceBlocks = ifconfigOut.split(/\n(?=utun|ppp)/);
  const interfaceIps: Map<string, string> = new Map();
  for (const block of interfaceBlocks) {
    const ifaceMatch = block.match(/^(utun\d+|ppp\d+)/);
    const inetMatch  = block.match(/inet (\d+\.\d+\.\d+\.\d+)/);
    if (ifaceMatch) {
      interfaceIps.set(ifaceMatch[1], inetMatch ? inetMatch[1] : "");
    }
  }

  // Get configured VPN connections from scutil
  let scutilOut = "";
  try {
    ({ stdout: scutilOut } = await execAsync("scutil --nc list 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch {
    scutilOut = "";
  }

  // Parse scutil output: lines like: * (Connected) <uuid> [<proto>/<type>] "<Name>" [...]
  const scutilLines = scutilOut.trim().split("\n").filter(Boolean);
  for (const line of scutilLines) {
    const statusMatch = line.match(/\((\w+)\)/);
    const nameMatch   = line.match(/"([^"]+)"/);
    const typeMatch   = line.match(/\[([^\]]+)\]/);
    if (!nameMatch) continue;
    const name   = nameMatch[1];
    const status = statusMatch ? statusMatch[1] : "Unknown";
    const type   = typeMatch   ? typeMatch[1]   : "VPN";
    connections.push({
      name,
      type,
      interface:  "",
      assignedIp: null,
      status,
    });
  }

  // Check for running VPN client processes
  let psOut = "";
  try {
    ({ stdout: psOut } = await execAsync("ps aux 2>/dev/null", {
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch {
    psOut = "";
  }

  const knownClients: Array<{ proc: string; label: string }> = [
    { proc: "AnyConnect",     label: "Cisco AnyConnect" },
    { proc: "vpnagentd",      label: "Cisco AnyConnect (agent)" },
    { proc: "GlobalProtect",  label: "Palo Alto GlobalProtect" },
    { proc: "PanGPA",         label: "Palo Alto GlobalProtect (agent)" },
    { proc: "dsAccessService",label: "Pulse Secure / Ivanti" },
    { proc: "Pulse Secure",   label: "Pulse Secure" },
    { proc: "warp-svc",       label: "Cloudflare WARP" },
    { proc: "WARP",           label: "Cloudflare WARP" },
    { proc: "openvpn",        label: "OpenVPN" },
    { proc: "wireguard",      label: "WireGuard" },
  ];

  for (const { proc, label } of knownClients) {
    if (psOut.includes(proc) && !installedClients.includes(label)) {
      installedClients.push(label);
    }
  }

  // Match interface IPs to connections
  for (const conn of connections) {
    for (const [iface, ip] of interfaceIps) {
      if (conn.status === "Connected" && !conn.interface) {
        conn.interface  = iface;
        conn.assignedIp = ip || null;
      }
    }
  }

  // Also surface raw utun/ppp interfaces that are up with IPs but have no named profile
  for (const [iface, ip] of interfaceIps) {
    if (ip && !connections.some((c) => c.interface === iface)) {
      connections.push({
        name:       iface,
        type:       iface.startsWith("utun") ? "Tunnel" : "PPP",
        interface:  iface,
        assignedIp: ip,
        status:     "Active",
      });
    }
  }

  const isConnected =
    connections.some((c) => c.status === "Connected" || c.status === "Active");

  return { isConnected, activeConnections: connections, installedClients };
}

// -- win32 implementation -----------------------------------------------------

async function checkVpnStatusWin32(): Promise<VpnStatusResult> {
  // Build the proc-label pairs inline so they don't need a separate PS file.
  const procListPs = WIN32_VPN_VENDOR_PROCS
    .map((e) => `[PSCustomObject]@{proc='${e.proc}';label='${e.label}'}`)
    .join(",\n  ");

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'

# 1. Native RAS-registered connections (IKEv2, SSTP, PPTP, L2TP).
$rasConns = @()
try { $rasConns += Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue } catch {}
try { $rasConns += Get-VpnConnection              -ErrorAction SilentlyContinue } catch {}

# 2. VPN adapters that are currently UP — catches WireGuard/OpenVPN/TAP-based
#    clients (ProtonVPN, NordVPN, Mullvad, Tailscale, etc.) that do NOT
#    register via Get-VpnConnection. Only UP adapters represent a live tunnel.
$vpnAdaptersUp = @(Get-NetAdapter | Where-Object {
  ($_.InterfaceDescription -match 'WireGuard|TAP-Windows|TAP |ProtonVPN|NordVPN|ExpressVPN|Mullvad|Tailscale|WARP|Tunnel|OpenVPN') -and
  $_.Status -eq 'Up'
} | ForEach-Object {
  $ip = (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Select-Object -First 1).IPAddress
  [PSCustomObject]@{ name=$_.Name; description=$_.InterfaceDescription; ip=[string]$ip }
})

# 3. Process scan — identifies which vendor VPN client is installed/running.
$vpnProcMap = @(
  ${procListPs}
)
$detectedClients = @()
foreach ($e in $vpnProcMap) {
  if (Get-Process -Name $e.proc -ErrorAction SilentlyContinue) {
    if (-not ($detectedClients -contains $e.label)) { $detectedClients += $e.label }
  }
}

[PSCustomObject]@{
  rasConnections  = @($rasConns | Select-Object Name,ServerAddress,TunnelType,ConnectionStatus)
  vpnAdaptersUp   = $vpnAdaptersUp
  detectedClients = $detectedClients
} | ConvertTo-Json -Depth 4 -Compress`.trim();

  const raw = await runPS(ps);
  let parsed: {
    rasConnections:  Array<{ Name: string; ServerAddress: string | null; TunnelType: string | null; ConnectionStatus: string }> | null;
    vpnAdaptersUp:   Array<{ name: string; description: string; ip: string | null }> | null;
    detectedClients: string[] | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { isConnected: false, activeConnections: [], installedClients: [] };
  }

  const connections: VpnConnection[] = [];

  // Native RAS connections
  for (const c of (parsed.rasConnections ?? [])) {
    connections.push({
      name:       c.Name       ?? "Unknown",
      type:       c.TunnelType ?? "VPN",
      interface:  "",
      assignedIp: null,
      status:     c.ConnectionStatus ?? "Unknown",
    });
  }

  // UP VPN adapters — each represents a live third-party VPN tunnel
  for (const a of (parsed.vpnAdaptersUp ?? [])) {
    if (!connections.some((c) => c.name === a.name)) {
      connections.push({
        name:       a.description || a.name,
        type:       "Tunnel",
        interface:  a.name,
        assignedIp: a.ip || null,
        status:     "Connected",
      });
    }
  }

  const installedClients = parsed.detectedClients ?? [];
  const isConnected = connections.some(
    (c) => c.status === "Connected" || c.status === "Active",
  );

  return { isConnected, activeConnections: connections, installedClients };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<VpnStatusResult> {
  const platform = os.platform();
  return platform === "win32"
    ? checkVpnStatusWin32()
    : checkVpnStatusDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
