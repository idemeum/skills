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
 * darwin  `systemextensionsctl list` to see all system extensions and state
 *         (activated, enabled, waiting for user, terminated, etc.)
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
  schema: {
    extensionName: z
      .string()
      .optional()
      .describe(
        "Extension name or bundle ID to check " +
        "(e.g. 'com.cisco.anyconnect.macos.acsock'). " +
        "Omit to list all network extensions.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ExtensionEntry {
  identifier:    string;
  teamId:        string;
  bundleVersion: string;
  state:         string;
  type:          string;
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

async function checkNetworkExtensionDarwin(
  extensionName: string | undefined,
): Promise<CheckNetworkExtensionResult> {
  let listOut = "";
  try {
    ({ stdout: listOut } = await execAsync("systemextensionsctl list 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch (err) {
    listOut = (err as { stdout?: string }).stdout ?? "";
  }

  const extensions: ExtensionEntry[] = [];

  // systemextensionsctl output lines look like:
  //   <teamId>  <state>  <bundleId> (<version>)  [<type>] "<display name>"
  // Example:
  //   DE8Y96K9QP  [activated enabled]  com.cisco.anyconnect.macos.acsock (1.0.0.0)  [Network Extension]
  const lines = listOut.trim().split("\n");
  for (const line of lines) {
    // Skip header lines
    if (
      line.trim() === "" ||
      line.startsWith("---") ||
      line.startsWith("enabled") ||
      line.startsWith("1 extension") ||
      /^\d+ extension/.test(line)
    ) continue;

    // Parse: teamId, state brackets, bundleId, version, type brackets
    const stateMatch   = line.match(/\[([^\]]+)\]/g);
    const bundleMatch  = line.match(/([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)\s+\(/);
    const versionMatch = line.match(/\(([^)]+)\)/);
    const teamMatch    = line.match(/^([A-Z0-9]{10})\s/);

    if (!bundleMatch) continue;

    const identifier    = bundleMatch[1];
    const teamId        = teamMatch    ? teamMatch[1]                       : "Unknown";
    const bundleVersion = versionMatch ? versionMatch[1]                    : "Unknown";
    const state         = stateMatch   ? stateMatch[0].replace(/[\[\]]/g, "") : "Unknown";
    const type          = stateMatch && stateMatch.length > 1
      ? stateMatch[1].replace(/[\[\]]/g, "")
      : "System Extension";

    extensions.push({ identifier, teamId, bundleVersion, state, type });
  }

  // Filter by extensionName if provided
  const filtered = extensionName
    ? extensions.filter(
        (e) =>
          e.identifier.toLowerCase().includes(extensionName.toLowerCase()) ||
          e.type.toLowerCase().includes(extensionName.toLowerCase()),
      )
    : extensions;

  const allActivated =
    filtered.length > 0 &&
    filtered.every(
      (e) =>
        e.state.includes("activated") ||
        e.state.includes("enabled"),
    );

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
