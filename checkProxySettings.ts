/**
 * mcp/skills/checkProxySettings.ts — check_proxy_settings skill
 *
 * Reports current system proxy configuration for all active network interfaces.
 * Misconfigured proxies are a common cause of internet failures while internal
 * resources remain accessible.
 *
 * Platform strategy
 * -----------------
 * darwin  `networksetup` commands per active network service for HTTP, HTTPS,
 *         PAC URL, and bypass domains
 * win32   PowerShell reads proxy settings from HKCU Internet Settings registry
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkProxySettings.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_proxy_settings",
  description:
    "Reports current system proxy configuration for all active network interfaces. " +
    "Misconfigured proxies are a common cause of internet failures while internal " +
    "resources remain accessible.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface ProxyEntry {
  enabled: boolean;
  server:  string;
  port:    number;
}

interface ProxyRow {
  type:    string;
  enabled: boolean;
  server:  string;
  port:    number;
}

interface CheckProxySettingsResult {
  proxies:    ProxyRow[];
  pacUrl:     string | null;
  bypassList: string[];
  anyEnabled: boolean;
  platform:   string;
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

function parseNetworksetupProxy(output: string): ProxyEntry | null {
  const enabledMatch = output.match(/Enabled:\s*(\w+)/i);
  const serverMatch  = output.match(/Server:\s*(.+)/i);
  const portMatch    = output.match(/Port:\s*(\d+)/i);

  if (!enabledMatch) return null;

  const enabled = enabledMatch[1].toLowerCase() === "yes";
  const server  = serverMatch?.[1]?.trim() ?? "";
  const port    = parseInt(portMatch?.[1] ?? "0", 10);

  // Only return non-null if we have a server configured (enabled or not)
  if (!server) return null;
  return { enabled, server, port };
}

// -- darwin implementation ----------------------------------------------------

async function checkProxySettingsDarwin(): Promise<CheckProxySettingsResult> {
  // Find first active network service
  let activeService = "Wi-Fi";
  try {
    const { stdout } = await execAsync("networksetup -listallnetworkservices");
    const services = stdout.split("\n").filter((l) => l.trim() && !l.includes("*"));
    // Skip the header line "An asterisk (*) denotes..."
    const real = services.filter((s) => !s.includes("asterisk") && !s.includes("denotes"));
    if (real.length > 0) activeService = real[0].trim();
  } catch { /* fallback to Wi-Fi */ }

  const safeService = activeService.replace(/'/g, "'\\''");

  // HTTP proxy
  let httpProxy: ProxyEntry | null = null;
  try {
    const { stdout } = await execAsync(`networksetup -getwebproxy '${safeService}'`);
    httpProxy = parseNetworksetupProxy(stdout);
  } catch { /* ignore */ }

  // HTTPS proxy
  let httpsProxy: ProxyEntry | null = null;
  try {
    const { stdout } = await execAsync(`networksetup -getsecurewebproxy '${safeService}'`);
    httpsProxy = parseNetworksetupProxy(stdout);
  } catch { /* ignore */ }

  // PAC URL
  let pacUrl: string | null = null;
  try {
    const { stdout } = await execAsync(`networksetup -getautoproxyurl '${safeService}'`);
    const urlMatch = stdout.match(/URL:\s*(.+)/i);
    const urlVal   = urlMatch?.[1]?.trim() ?? "";
    const enabledMatch = stdout.match(/Enabled:\s*(\w+)/i);
    if (urlVal && urlVal !== "(null)" && enabledMatch?.[1]?.toLowerCase() === "yes") {
      pacUrl = urlVal;
    }
  } catch { /* ignore */ }

  // Bypass domains
  let bypassList: string[] = [];
  try {
    const { stdout } = await execAsync(`networksetup -getproxybypassdomains '${safeService}'`);
    bypassList = stdout.trim().split("\n").filter((l) => l.trim() && !l.includes("There aren't"));
  } catch { /* ignore */ }

  const proxies: ProxyRow[] = [
    ...(httpProxy  ? [{ type: "HTTP",  ...httpProxy  }] : []),
    ...(httpsProxy ? [{ type: "HTTPS", ...httpsProxy }] : []),
  ];

  const anyEnabled = proxies.some((p) => p.enabled) || pacUrl !== null;

  return {
    proxies,
    pacUrl,
    bypassList,
    anyEnabled,
    platform: "darwin",
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkProxySettingsWin32(): Promise<CheckProxySettingsResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' |
  Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL |
  ConvertTo-Json -Compress`.trim();

  let rawData: any = {};
  try {
    const raw = await runPS(ps);
    if (raw) rawData = JSON.parse(raw);
  } catch { /* fallback to empty */ }

  const proxyEnable = Number(rawData.ProxyEnable ?? 0) === 1;
  const proxyServer = String(rawData.ProxyServer ?? "");
  const pacUrl      = rawData.AutoConfigURL ? String(rawData.AutoConfigURL) : null;
  const override    = rawData.ProxyOverride  ? String(rawData.ProxyOverride) : "";

  // ProxyServer may be "host:port" or "http=host:port;https=host:port"
  let httpProxy:  ProxyEntry | null = null;
  let httpsProxy: ProxyEntry | null = null;

  if (proxyServer) {
    if (proxyServer.includes("=")) {
      // Per-protocol format
      const parts = proxyServer.split(";");
      for (const part of parts) {
        const [proto, addr] = part.split("=");
        const [srv, portStr] = (addr ?? "").split(":");
        const entry: ProxyEntry = { enabled: proxyEnable, server: srv ?? "", port: parseInt(portStr ?? "80", 10) };
        if (proto?.toLowerCase().includes("http") && !proto.toLowerCase().includes("https")) httpProxy = entry;
        if (proto?.toLowerCase().includes("https")) httpsProxy = entry;
      }
    } else {
      // Single proxy for all protocols
      const [srv, portStr] = proxyServer.split(":");
      const entry: ProxyEntry = { enabled: proxyEnable, server: srv ?? proxyServer, port: parseInt(portStr ?? "80", 10) };
      httpProxy  = entry;
      httpsProxy = { ...entry };
    }
  }

  const bypassList = override
    ? override.split(";").map((s: string) => s.trim()).filter(Boolean)
    : [];

  const proxies: ProxyRow[] = [
    ...(httpProxy  ? [{ type: "HTTP",  ...httpProxy  }] : []),
    ...(httpsProxy ? [{ type: "HTTPS", ...httpsProxy }] : []),
  ];

  const anyEnabled = proxyEnable || pacUrl !== null;

  return {
    proxies,
    pacUrl,
    bypassList,
    anyEnabled,
    platform: "win32",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkProxySettingsWin32()
    : checkProxySettingsDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
