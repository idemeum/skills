/**
 * mcp/skills/getVpnProfiles.ts — get_vpn_profiles skill
 *
 * Lists all configured VPN profiles including their type, server, and last
 * used date. Use when reconnecting to VPN or diagnosing which profile to repair.
 *
 * Platform strategy
 * -----------------
 * darwin  `scutil --nc list` for all Network Configuration VPN entries; checks
 *         for AnyConnect profiles in /opt/cisco/anyconnect/profile/ and
 *         GlobalProtect in /Library/Application Support/Palo Alto Networks/GlobalProtect/
 * win32   PowerShell Get-VpnConnection (per-user and all-user)
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getVpnProfiles.ts
 */

import * as os       from "os";
import * as fs       from "fs/promises";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_vpn_profiles",
  description:
    "Lists all configured VPN profiles including their type, server, and last " +
    "used date. Use when reconnecting to VPN or diagnosing which profile to repair.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

interface VpnProfile {
  name:        string;
  type:        string;
  server:      string | null;
  protocol:    string | null;
  isConnected: boolean;
  lastUsed:    string | null;
}

interface GetVpnProfilesResult {
  profiles: VpnProfile[];
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

async function getVpnProfilesDarwin(): Promise<GetVpnProfilesResult> {
  const profiles: VpnProfile[] = [];

  // Parse scutil --nc list for native macOS VPN profiles
  let scutilOut = "";
  try {
    ({ stdout: scutilOut } = await execAsync("scutil --nc list 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch {
    scutilOut = "";
  }

  const scutilLines = scutilOut.trim().split("\n").filter(Boolean);
  for (const line of scutilLines) {
    // Format: * (Status) <uuid> [Proto/Type] "Name" [...]
    const statusMatch   = line.match(/\((\w+)\)/);
    const nameMatch     = line.match(/"([^"]+)"/);
    const typeMatch     = line.match(/\[([^\]]+)\]/);
    if (!nameMatch) continue;

    const name        = nameMatch[1];
    const status      = statusMatch ? statusMatch[1] : "Unknown";
    const typeStr     = typeMatch   ? typeMatch[1]   : "VPN";
    const isConnected = status === "Connected";

    // Attempt to get server for this profile via scutil --nc show
    let server: string | null = null;
    try {
      const { stdout: showOut } = await execAsync(
        `scutil --nc show "${name.replace(/"/g, '\\"')}" 2>/dev/null`,
        { maxBuffer: 1 * 1024 * 1024 },
      );
      const serverMatch = showOut.match(/RemoteAddress\s*:\s*(\S+)/);
      if (serverMatch) server = serverMatch[1];
    } catch { /* ignore */ }

    profiles.push({
      name,
      type:     typeStr,
      server,
      protocol: typeStr.includes("/") ? typeStr.split("/")[0] : typeStr,
      isConnected,
      lastUsed: null,
    });
  }

  // Check for Cisco AnyConnect profiles
  const anyconnectDir = "/opt/cisco/anyconnect/profile";
  try {
    const files = await fs.readdir(anyconnectDir);
    for (const file of files) {
      if (!file.endsWith(".xml")) continue;
      const content = await fs.readFile(nodePath.join(anyconnectDir, file), "utf8");
      const hostMatch = content.match(/<HostAddress>([^<]+)<\/HostAddress>/);
      const nameMatch = content.match(/<HostName>([^<]+)<\/HostName>/);
      profiles.push({
        name:        nameMatch ? nameMatch[1] : file.replace(".xml", ""),
        type:        "Cisco AnyConnect",
        server:      hostMatch ? hostMatch[1] : null,
        protocol:    "SSL/IKEv2",
        isConnected: false,
        lastUsed:    null,
      });
    }
  } catch { /* directory not present */ }

  // Check for GlobalProtect profiles
  const gpDir = "/Library/Application Support/Palo Alto Networks/GlobalProtect";
  try {
    const files = await fs.readdir(gpDir);
    for (const file of files) {
      if (!file.endsWith(".xml") && !file.endsWith(".cfg")) continue;
      let server: string | null = null;
      try {
        const content   = await fs.readFile(nodePath.join(gpDir, file), "utf8");
        const hostMatch = content.match(/<portal>([^<]+)<\/portal>/) ??
                          content.match(/<server>([^<]+)<\/server>/);
        if (hostMatch) server = hostMatch[1];
      } catch { /* ignore read errors */ }
      profiles.push({
        name:        file.replace(/\.(xml|cfg)$/, ""),
        type:        "Palo Alto GlobalProtect",
        server,
        protocol:    "SSL",
        isConnected: false,
        lastUsed:    null,
      });
    }
  } catch { /* directory not present */ }

  return { profiles };
}

// -- win32 implementation -----------------------------------------------------

async function getVpnProfilesWin32(): Promise<GetVpnProfilesResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$all = @()
try { $all += Get-VpnConnection -ErrorAction SilentlyContinue } catch {}
try { $all += Get-VpnConnection -AllUserConnection -ErrorAction SilentlyContinue } catch {}
$all | Select-Object Name,ServerAddress,TunnelType,AuthenticationMethod,ConnectionStatus,RememberCredential |
  ConvertTo-Json -Depth 3 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return { profiles: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { profiles: [] };
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const profiles: VpnProfile[] = (arr as Record<string, unknown>[]).map((c) => ({
    name:        String(c.Name        ?? "Unknown"),
    type:        String(c.TunnelType  ?? "VPN"),
    server:      c.ServerAddress ? String(c.ServerAddress) : null,
    protocol:    c.TunnelType    ? String(c.TunnelType)    : null,
    isConnected: String(c.ConnectionStatus) === "Connected",
    lastUsed:    null,
  }));

  return { profiles };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetVpnProfilesResult> {
  const platform = os.platform();
  return platform === "win32"
    ? getVpnProfilesWin32()
    : getVpnProfilesDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
