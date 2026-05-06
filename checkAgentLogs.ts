/**
 * mcp/skills/checkAgentLogs.ts — check_agent_logs skill
 *
 * Retrieves recent log entries from a security agent's log file to identify
 * errors, connectivity issues, or policy problems. Use when an agent process
 * is running but behaving incorrectly.
 *
 * Platform strategy
 * -----------------
 * darwin  `tail -n {lines} {logPath}` with optional grep for error keywords
 * win32   PowerShell Get-EventLog for the relevant event source
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkAgentLogs.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_agent_logs",
  description:
    "Retrieves recent log entries from a security agent's log file to identify " +
    "errors, connectivity issues, or policy problems. Use when an agent process " +
    "is running but behaving incorrectly.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    agent: z
      .enum(["crowdstrike", "sentinelone", "jamf", "carbonblack", "cylance", "defender"])
      .describe("Security agent to get logs for"),
    lines: z
      .number()
      .optional()
      .describe("Number of recent log lines. Default: 50"),
    errorOnly: z
      .boolean()
      .optional()
      .describe("Return only lines containing ERROR, WARN, or FAIL. Default: false"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AgentLogsResult {
  agent:        string;
  logPath:      string | null;
  accessible:   boolean;
  entries:      string[];
  errorCount:   number;
  warningCount: number;
  message:      string;
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

// -- darwin: resolve log path -------------------------------------------------

async function resolveDarwinLogPath(agent: string): Promise<string | null> {
  switch (agent) {
    case "crowdstrike":
      return "/var/log/crowdstrike/falconctl.log";
    case "sentinelone": {
      // Find the newest file in the directory
      try {
        const { stdout } = await execAsync(
          "ls -t /var/log/sentinelone/ 2>/dev/null | head -1",
          { maxBuffer: 1024 * 1024, shell: "/bin/bash" },
        );
        const fname = stdout.trim();
        return fname ? nodePath.join("/var/log/sentinelone", fname) : "/var/log/sentinelone";
      } catch {
        return "/var/log/sentinelone";
      }
    }
    case "jamf":
      return "/private/var/log/jamf.log";
    case "defender": {
      try {
        const { stdout } = await execAsync(
          "ls -t /Library/Logs/Microsoft/mdatp/ 2>/dev/null | head -1",
          { maxBuffer: 1024 * 1024, shell: "/bin/bash" },
        );
        const fname = stdout.trim();
        return fname
          ? nodePath.join("/Library/Logs/Microsoft/mdatp", fname)
          : "/Library/Logs/Microsoft/mdatp";
      } catch {
        return "/Library/Logs/Microsoft/mdatp";
      }
    }
    case "carbonblack":
      return "/var/log/CbOsxSensor.log";
    case "cylance":
      return "/var/log/cylance/cyagent.log";
    default:
      return null;
  }
}

// -- darwin implementation ----------------------------------------------------

async function checkAgentLogsDarwin(
  agent:     string,
  lines:     number,
  errorOnly: boolean,
): Promise<AgentLogsResult> {
  const logPath = await resolveDarwinLogPath(agent);
  if (!logPath) {
    return {
      agent, logPath: null, accessible: false, entries: [],
      errorCount: 0, warningCount: 0, message: `No known log path for agent: ${agent}`,
    };
  }

  let rawOutput = "";
  let accessible = true;
  try {
    const safePath = logPath.replace(/'/g, `'\\''`);
    if (errorOnly) {
      const { stdout } = await execAsync(
        `tail -n ${lines} '${safePath}' 2>/dev/null | grep -iE 'ERROR|WARN|FAIL'`,
        { maxBuffer: 5 * 1024 * 1024, shell: "/bin/bash" },
      );
      rawOutput = stdout;
    } else {
      const { stdout } = await execAsync(
        `tail -n ${lines} '${safePath}' 2>/dev/null`,
        { maxBuffer: 5 * 1024 * 1024, shell: "/bin/bash" },
      );
      rawOutput = stdout;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Permission denied") || msg.includes("No such file")) {
      accessible = false;
    }
    rawOutput = (err as { stdout?: string }).stdout ?? "";
  }

  const entries      = rawOutput.trim().split("\n").filter(Boolean);
  const errorCount   = entries.filter((l) => /error/i.test(l)).length;
  const warningCount = entries.filter((l) => /warn/i.test(l)).length;

  return {
    agent,
    logPath,
    accessible,
    entries,
    errorCount,
    warningCount,
    message: accessible
      ? `Retrieved ${entries.length} log lines from ${logPath}`
      : `Log file not accessible: ${logPath} (may require elevated privileges)`,
  };
}

// -- win32 implementation -----------------------------------------------------

const WIN32_EVENT_SOURCES: Record<string, string> = {
  crowdstrike: "CSFalconService",
  sentinelone: "SentinelAgent",
  defender:    "Microsoft Antimalware",
  carbonblack: "CbDefense",
  cylance:     "Cylance",
  jamf:        "Jamf",
};

async function checkAgentLogsWin32(
  agent:     string,
  lines:     number,
  _errorOnly: boolean,
): Promise<AgentLogsResult> {
  const source = WIN32_EVENT_SOURCES[agent] ?? agent;
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$entries = Get-EventLog -LogName Application -Source '${source}' -Newest ${lines} -EntryType Error,Warning -ErrorAction SilentlyContinue |
           Select-Object TimeGenerated,EntryType,Message
if ($entries) { @($entries) | ConvertTo-Json -Depth 2 -Compress } else { '[]' }`.trim();

  let entries: string[] = [];
  let accessible = true;
  try {
    const raw = await runPS(ps);
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      TimeGenerated: string;
      EntryType:     string;
      Message:       string;
    }>;
    entries = parsed.map(
      (e) => `[${e.TimeGenerated}] ${e.EntryType}: ${e.Message?.slice(0, 200) ?? ""}`,
    );
  } catch {
    accessible = false;
  }

  const errorCount   = entries.filter((l) => /error/i.test(l)).length;
  const warningCount = entries.filter((l) => /warn/i.test(l)).length;

  return {
    agent,
    logPath:   `Windows Event Log / Application / ${source}`,
    accessible,
    entries,
    errorCount,
    warningCount,
    message: accessible
      ? `Retrieved ${entries.length} event log entries for ${source}`
      : `Could not read Windows Event Log for source: ${source}`,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  agent,
  lines     = 50,
  errorOnly = false,
}: {
  agent:      "crowdstrike" | "sentinelone" | "jamf" | "carbonblack" | "cylance" | "defender";
  lines?:     number;
  errorOnly?: boolean;
}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkAgentLogsWin32(agent, lines, errorOnly)
    : checkAgentLogsDarwin(agent, lines, errorOnly);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ agent: "jamf" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
