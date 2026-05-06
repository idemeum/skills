/**
 * mcp/skills/checkAgentProcess.ts — check_agent_process skill
 *
 * Checks if a security agent process is running. Supports CrowdStrike Falcon,
 * SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender.
 * Use at the start of any security agent repair workflow.
 *
 * Platform strategy
 * -----------------
 * darwin  `pgrep -x {name}` for each known process name variant
 * win32   PowerShell Get-Service for each known service name
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkAgentProcess.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_agent_process",
  description:
    "Checks if a security agent process is running. Supports CrowdStrike Falcon, " +
    "SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender. " +
    "Use at the start of any security agent repair workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    agent: z
      .enum(["crowdstrike", "sentinelone", "jamf", "carbonblack", "cylance", "defender", "auto"])
      .optional()
      .describe("Agent to check. auto=detect all known agents. Default: auto"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AgentResult {
  name:        string;
  processName: string;
  isRunning:   boolean;
  pid:         number | null;
  platform:    string;
}

interface AgentDefinition {
  name:            string;
  darwinNames:     string[];
  win32Service:    string | null;
}

// -- Agent definitions --------------------------------------------------------

const AGENTS: AgentDefinition[] = [
  {
    name:         "crowdstrike",
    darwinNames:  ["com.crowdstrike.falcon.Agent", "falcond", "Falcon"],
    win32Service: "CSFalconService",
  },
  {
    name:         "sentinelone",
    darwinNames:  ["SentinelAgent", "sentineld", "SentinelOne"],
    win32Service: "SentinelAgent",
  },
  {
    name:         "jamf",
    darwinNames:  ["JamfAgent", "jamf"],
    win32Service: null,
  },
  {
    name:         "defender",
    darwinNames:  ["Microsoft Defender", "mdatp", "wdavdaemon"],
    win32Service: "WinDefend",
  },
  {
    name:         "carbonblack",
    darwinNames:  ["cbagentd", "CbOsxSensorService"],
    win32Service: "CbDefense",
  },
  {
    name:         "cylance",
    darwinNames:  ["CylanceSvc"],
    win32Service: null,
  },
];

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

async function checkAgentDarwin(agentDef: AgentDefinition): Promise<AgentResult> {
  const platform = "darwin";
  for (const procName of agentDef.darwinNames) {
    try {
      const safeName = procName.replace(/'/g, `'\\''`);
      const { stdout } = await execAsync(
        `pgrep -x '${safeName}' 2>/dev/null`,
        { maxBuffer: 1024 * 1024 },
      );
      const pidStr = stdout.trim().split("\n")[0];
      const pid    = pidStr ? parseInt(pidStr, 10) : null;
      if (pid && !isNaN(pid)) {
        return { name: agentDef.name, processName: procName, isRunning: true, pid, platform };
      }
    } catch {
      // pgrep exits non-zero when no match — try next name
    }
  }
  return {
    name:        agentDef.name,
    processName: agentDef.darwinNames[0],
    isRunning:   false,
    pid:         null,
    platform,
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkAgentWin32(agentDef: AgentDefinition): Promise<AgentResult> {
  const platform = "win32";
  if (!agentDef.win32Service) {
    return {
      name:        agentDef.name,
      processName: agentDef.name,
      isRunning:   false,
      pid:         null,
      platform,
    };
  }
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$svc = Get-Service -Name '${agentDef.win32Service}' -ErrorAction SilentlyContinue |
       Select-Object Name,Status
if ($svc) { $svc | ConvertTo-Json -Compress } else { 'null' }`.trim();

  const raw = await runPS(ps);
  if (!raw || raw === "null") {
    return { name: agentDef.name, processName: agentDef.win32Service, isRunning: false, pid: null, platform };
  }
  const parsed = JSON.parse(raw) as { Name: string; Status: string };
  const isRunning = parsed.Status === "Running";
  return {
    name:        agentDef.name,
    processName: parsed.Name,
    isRunning,
    pid:         null,
    platform,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  agent = "auto",
}: {
  agent?: "crowdstrike" | "sentinelone" | "jamf" | "carbonblack" | "cylance" | "defender" | "auto";
} = {}) {
  const platform   = os.platform();
  const toCheck    = agent === "auto" ? AGENTS : AGENTS.filter((a) => a.name === agent);
  const results: AgentResult[] = [];

  for (const agentDef of toCheck) {
    const result = platform === "win32"
      ? await checkAgentWin32(agentDef)
      : await checkAgentDarwin(agentDef);
    results.push(result);
  }

  return {
    detectedAgents: results,
    anyRunning:     results.some((r) => r.isRunning),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
