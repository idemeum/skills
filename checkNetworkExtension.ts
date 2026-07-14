/**
 * mcp/skills/checkNetworkExtension.ts — check_network_extension skill
 *
 * Checks if VPN or security agent network extensions (system extensions) are
 * loaded and approved. Network extensions must be approved in System Settings
 * to function. macOS only for system extension checking; Windows checks network
 * driver status.
 *
 * Platform strategy
 * -----------------
 * darwin  TWO sources merged: `systemextensionsctl list` for system extensions
 *         (sysext — carry the activated / enabled / waiting-for-user approval
 *         state) AND `pluginkit -m -p <ne-protocol>` for app-extension (appex)
 *         network providers, which many VPN clients ship and which do NOT appear
 *         in systemextensionsctl (the reason this tool used to return empty for a
 *         configured VPN). Apple's own providers are filtered out.
 * win32   PowerShell Get-NetAdapter for network driver/adapter status
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkNetworkExtension.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_network_extension",
  description:
    "Checks if VPN or security agent network extensions (system extensions) are " +
    "loaded and approved. Network extensions must be approved in System Settings " +
    "to function. macOS only for system extension checking; Windows checks network " +
    "driver status.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["extensions","allActivated"],
  schema: {
    extensionName: z
      .string()
      .nullable().optional()
      .describe(
        "Extension name or bundle ID to check " +
        "(e.g. 'com.cisco.anyconnect.macos.acsock'). " +
        "Omit to list all network extensions.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ExtensionEntry {
  identifier:    string;   // bundle ID
  name:          string;   // display name (sysext "name" column / appex bundle leaf)
  teamId:        string;
  bundleVersion: string;
  state:         string;   // e.g. "activated enabled", "activated waiting for user", "enabled" (appex)
  type:          string;   // "System Extension" | "App Extension" | "Network Adapter" (win32)
}

interface CheckNetworkExtensionResult {
  extensions:   ExtensionEntry[];
  allActivated: boolean;
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

/** An extension is "ready" only when enabled AND not still pending user approval.
 *  NOTE: "activated waiting for user" CONTAINS "activated", so we must NOT treat
 *  presence of "activated" as ready (the prior bug) — gate on "enabled" and
 *  explicitly exclude the pending state. */
function isReady(state: string): boolean {
  return state.includes("enabled") && !state.includes("waiting for user");
}

/**
 * Parse one `systemextensionsctl list` data row. Real output is TAB-separated:
 *   enabled  active  teamID  bundleID (version)  name  [state]
 *   *  *  7L2RM5R3FG  com.paloaltonetworks.GlobalProtect.client.extension (6.0.4)  GlobalProtect  [activated enabled]
 * Falls back to whitespace/regex extraction if the row isn't cleanly tabbed.
 */
function parseSysextRow(line: string): ExtensionEntry | null {
  const cols = line.split("\t").map((c) => c.trim()).filter(Boolean);
  if (cols.length >= 5) {
    const bundleCol = cols.find((c) => /[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\s*\(/.test(c)) ?? cols[3];
    const idMatch   = bundleCol.match(/([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
    if (!idMatch) return null;
    const verMatch  = bundleCol.match(/\(([^)]+)\)/);
    const stateCol  = cols.find((c) => c.startsWith("[")) ?? cols[cols.length - 1];
    const bundleIdx = cols.indexOf(bundleCol);
    const nameCol   = cols[bundleIdx + 1];
    return {
      identifier:    idMatch[1],
      name:          nameCol && !nameCol.startsWith("[") ? nameCol : idMatch[1],
      teamId:        cols.find((c) => /^[A-Z0-9]{10}$/.test(c)) ?? "Unknown",
      bundleVersion: verMatch ? verMatch[1] : "Unknown",
      state:         stateCol.replace(/[[\]]/g, "").trim(),
      type:          "System Extension",
    };
  }
  const idMatch    = line.match(/([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)\s*\(/);
  if (!idMatch) return null;
  const verMatch   = line.match(/\(([^)]+)\)/);
  const stateMatch = line.match(/\[([^\]]+)\]/);
  const teamMatch  = line.match(/\b([A-Z0-9]{10})\b/);
  return {
    identifier:    idMatch[1],
    name:          idMatch[1],
    teamId:        teamMatch ? teamMatch[1] : "Unknown",
    bundleVersion: verMatch ? verMatch[1] : "Unknown",
    state:         stateMatch ? stateMatch[1].trim() : "Unknown",
    type:          "System Extension",
  };
}

/** System extensions (sysext) — Cisco Secure Client, GlobalProtect sysext, etc.
 *  These carry the user-approval state the Step 7 gate keys on. */
async function listSystemExtensions(): Promise<ExtensionEntry[]> {
  let out = "";
  try {
    ({ stdout: out } = await execAsync("systemextensionsctl list 2>/dev/null", { maxBuffer: 5 * 1024 * 1024 }));
  } catch (err) {
    out = (err as { stdout?: string }).stdout ?? "";
  }
  const entries: ExtensionEntry[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("---") || t.startsWith("enabled") || /^\d+\s+extension/.test(t)) continue;
    const row = parseSysextRow(line);
    if (row) entries.push(row);
  }
  return entries;
}

/**
 * App-extension (appex) network providers. Many VPN clients ship these instead
 * of system extensions, and they do NOT appear in `systemextensionsctl` — the
 * main reason check_network_extension used to return empty for a configured VPN.
 * `pluginkit -m -p <protocol>` lists them. appex have no separate System-Settings
 * approval (they enable with the VPN config), so we mark them "enabled". Apple's
 * own providers (com.apple.*) are filtered out — we only want third-party clients.
 */
async function listAppExtensions(): Promise<ExtensionEntry[]> {
  const protocols = [
    "com.apple.networkextension.packet-tunnel",
    "com.apple.networkextension.app-proxy",
  ];
  const entries: ExtensionEntry[] = [];
  for (const proto of protocols) {
    let out = "";
    try {
      ({ stdout: out } = await execAsync(`pluginkit -m -p ${proto} 2>/dev/null`, { maxBuffer: 2 * 1024 * 1024 }));
    } catch { /* pluginkit absent or no matches — skip */ }
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^([a-zA-Z0-9._-]+?)\(([^)]*)\)\s*$/);
      if (!m) continue;
      const identifier = m[1];
      if (identifier.startsWith("com.apple.")) continue;       // skip Apple's own providers
      if (entries.some((e) => e.identifier === identifier)) continue;
      entries.push({
        identifier,
        name:          identifier.split(".").pop() ?? identifier,
        teamId:        "Unknown",
        bundleVersion: m[2] || "Unknown",
        state:         "enabled",
        type:          "App Extension",
      });
    }
  }
  return entries;
}

async function checkNetworkExtensionDarwin(
  extensionName: string | undefined,
): Promise<CheckNetworkExtensionResult> {
  const [sysext, appex] = await Promise.all([listSystemExtensions(), listAppExtensions()]);
  // sysext first (they carry the approval state), then appex not already seen as a sysext.
  const all = [...sysext, ...appex.filter((a) => !sysext.some((s) => s.identifier === a.identifier))];

  const filtered = extensionName
    ? all.filter(
        (e) =>
          e.identifier.toLowerCase().includes(extensionName.toLowerCase()) ||
          e.name.toLowerCase().includes(extensionName.toLowerCase()),
      )
    : all;

  const allActivated = filtered.length > 0 && filtered.every((e) => isReady(e.state));

  return { extensions: filtered, allActivated };
}

// -- win32 implementation -----------------------------------------------------

async function checkNetworkExtensionWin32(
  extensionName: string | undefined,
): Promise<CheckNetworkExtensionResult> {
  const filterClause = extensionName
    ? `| Where-Object { $_.DriverDescription -match '${extensionName.replace(/'/g, "''")}' -or $_.Name -match '${extensionName.replace(/'/g, "''")}' }`
    : "";

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-NetAdapter ${filterClause} |
  Select-Object Name,Status,DriverDescription,DriverVersion,DriverProvider |
  ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return { extensions: [], allActivated: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { extensions: [], allActivated: false };
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const extensions: ExtensionEntry[] = (arr as Record<string, unknown>[]).map((a) => ({
    identifier:    String(a.Name             ?? "Unknown"),
    name:          String(a.DriverDescription ?? a.Name ?? "Unknown"),
    teamId:        String(a.DriverProvider   ?? "Unknown"),
    bundleVersion: String(a.DriverVersion    ?? "Unknown"),
    state:         String(a.Status           ?? "Unknown"),
    type:          String(a.DriverDescription ?? "Network Adapter"),
  }));

  const allActivated =
    extensions.length > 0 &&
    extensions.every((e) => e.state === "Up");

  return { extensions, allActivated };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  extensionName,
}: {
  extensionName?: string;
} = {}): Promise<CheckNetworkExtensionResult> {
  const platform = os.platform();
  return platform === "win32"
    ? checkNetworkExtensionWin32(extensionName)
    : checkNetworkExtensionDarwin(extensionName);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
