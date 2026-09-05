/**
 * mcp/skills/getAgentVersion.ts — get_agent_version skill
 *
 * Returns the installed version of a security agent. Use to verify the agent
 * is on the expected version or to identify an outdated installation that
 * needs updating.
 *
 * Platform strategy
 * -----------------
 * darwin  plutil / jamf / mdatp commands, or reads Info.plist directly
 * win32   PowerShell Get-WmiObject Win32_Product
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getAgentVersion.ts
 */

import * as os       from "os";
import * as fs       from "fs/promises";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_agent_version",
  description:
    "Returns the installed version of a security agent. Use to verify the agent " +
    "is on the expected version or to identify an outdated installation that needs updating.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["agent","installedVersion","installPath","found","message"],
  schema: {
    agent: z
      .enum(["crowdstrike", "sentinelone", "jamf", "carbonblack", "cylance", "defender"])
      .describe("Security agent to get version for"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AgentVersionResult {
  agent:            string;
  installedVersion: string | null;
  installPath:      string | null;
  found:            boolean;
  message:          string;
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

// -- darwin helper: extract version from Info.plist ---------------------------

async function versionFromPlist(plistPath: string): Promise<string | null> {
  try {
    const safePath = plistPath.replace(/'/g, `'\\''`);
    const { stdout } = await execAsync(
      `plutil -extract CFBundleShortVersionString raw -o - '${safePath}' 2>/dev/null`,
      { maxBuffer: 1024 * 1024 },
    );
    const v = stdout.trim();
    return v || null;
  } catch {
    return null;
  }
}

// -- darwin implementation ----------------------------------------------------

/**
 * The candidate path, or null when nothing is there.
 *
 * Every vendor below has a well-known install location, and it is tempting to
 * report that constant as `installPath` and be done. Doing so makes `found`
 * — derived from `installPath !== null` — true on every machine for every
 * vendor whose path is hardcoded, which is what shipped: only sentinelone,
 * the one case that actually searched, could ever come back not-found.
 *
 * Observed 2026-09-04: a Mac with Falcon and the jamf binary installed
 * reported Defender, Carbon Black and Cylance as present too, so
 * survey_security_agent's presence filter had nothing to exclude and the
 * skill's "no known agent" exit stayed unreachable.
 */
export async function pathIfPresent(candidate: string): Promise<string | null> {
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function getAgentVersionDarwin(
  agent: string,
): Promise<AgentVersionResult> {
  let installPath: string | null = null;
  let version: string | null     = null;
  let message                    = "";

  try {
    switch (agent) {
      case "crowdstrike": {
        installPath = await pathIfPresent("/Applications/Falcon.app");
        version     = installPath ? await versionFromPlist(`${installPath}/Contents/Info.plist`) : null;
        message     = !installPath
          ? "Falcon.app not found in /Applications"
          : version ? `CrowdStrike Falcon version ${version}` : "Falcon.app found but version unreadable";
        break;
      }
      case "sentinelone": {
        // SentinelOne may have version in app bundle name
        const safePath = "/Applications".replace(/'/g, `'\\''`);
        const { stdout } = await execAsync(
          `find '${safePath}' -maxdepth 1 -name "SentinelOne*.app" 2>/dev/null`,
          { maxBuffer: 1024 * 1024 },
        );
        installPath = stdout.trim().split("\n")[0] || null;
        if (installPath) {
          version = await versionFromPlist(`${installPath}/Contents/Info.plist`);
          message = version ? `SentinelOne version ${version}` : "SentinelOne.app found but version unreadable";
        } else {
          message = "SentinelOne.app not found in /Applications";
        }
        break;
      }
      case "jamf": {
        installPath = await pathIfPresent("/usr/local/bin/jamf");
        if (installPath) {
          const { stdout } = await execAsync("jamf version 2>/dev/null", { maxBuffer: 1024 * 1024 });
          const match = stdout.match(/(\d+\.\d+[\.\d]*)/);
          version     = match ? match[1] : null;
        }
        message = !installPath
          ? "jamf binary not found at /usr/local/bin/jamf"
          : version ? `Jamf version ${version}` : "jamf command found but version unreadable";
        break;
      }
      case "defender": {
        installPath = await pathIfPresent("/Applications/Microsoft Defender.app");
        // mdatp answers even when the bundle sits elsewhere, so try it first
        // and let a version it reports stand as evidence of an install.
        try {
          const { stdout } = await execAsync("mdatp version 2>/dev/null", { maxBuffer: 1024 * 1024 });
          const match = stdout.match(/(\d+\.\d+[\.\d]*)/);
          version     = match ? match[1] : null;
        } catch {
          version = null;
        }
        if (!version && installPath) {
          version = await versionFromPlist(`${installPath}/Contents/Info.plist`);
        }
        message = !installPath && !version
          ? "Microsoft Defender not found"
          : version ? `Microsoft Defender version ${version}` : "Defender found but version unreadable";
        break;
      }
      case "carbonblack": {
        installPath = await pathIfPresent("/Applications/VMware Carbon Black Cloud.app");
        version     = installPath ? await versionFromPlist(`${installPath}/Contents/Info.plist`) : null;
        message     = !installPath
          ? "Carbon Black app not found in /Applications"
          : version ? `Carbon Black version ${version}` : "Carbon Black app found but version unreadable";
        break;
      }
      case "cylance": {
        installPath = await pathIfPresent("/Applications/Cylance/CylanceSvc.app");
        version     = installPath ? await versionFromPlist(`${installPath}/Contents/Info.plist`) : null;
        message     = !installPath
          ? "CylanceSvc.app not found in /Applications/Cylance"
          : version ? `Cylance version ${version}` : "CylanceSvc.app found but version unreadable";
        break;
      }
      default:
        message = `Unknown agent: ${agent}`;
    }
  } catch (err) {
    message = `Error reading version: ${(err as Error).message}`;
  }

  return {
    agent,
    installedVersion: version,
    installPath,
    found:   version !== null || installPath !== null,
    message,
  };
}

// -- win32 implementation -----------------------------------------------------

const WIN32_AGENT_NAMES: Record<string, string> = {
  crowdstrike: "CrowdStrike",
  sentinelone: "SentinelOne",
  jamf:        "Jamf",
  carbonblack: "Carbon Black",
  cylance:     "Cylance",
  defender:    "Windows Defender",
};

async function getAgentVersionWin32(
  agent: string,
): Promise<AgentVersionResult> {
  const agentDisplayName = WIN32_AGENT_NAMES[agent] ?? agent;
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$prod = Get-WmiObject Win32_Product |
        Where-Object { $_.Name -match '${agentDisplayName}' } |
        Select-Object Name,Version |
        Select-Object -First 1
if ($prod) { $prod | ConvertTo-Json -Compress } else { 'null' }`.trim();

  const raw = await runPS(ps);
  if (!raw || raw === "null") {
    return {
      agent,
      installedVersion: null,
      installPath:      null,
      found:            false,
      message:          `${agentDisplayName} not found in Win32_Product`,
    };
  }
  const parsed = JSON.parse(raw) as { Name: string; Version: string };
  return {
    agent,
    installedVersion: parsed.Version || null,
    installPath:      null,
    found:            true,
    message:          `${parsed.Name} version ${parsed.Version}`,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  agent,
}: {
  agent: "crowdstrike" | "sentinelone" | "jamf" | "carbonblack" | "cylance" | "defender";
}) {
  const platform = os.platform();
  return platform === "win32"
    ? getAgentVersionWin32(agent)
    : getAgentVersionDarwin(agent);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ agent: "crowdstrike" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
