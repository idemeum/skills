/**
 * mcp/skills/killProcess.ts — kill_process skill
 *
 * Terminates a process by name or PID. Defaults to dry-run to prevent
 * accidental termination of critical system processes.
 *
 * Platform strategy
 * -----------------
 * darwin  pkill / kill builtins; pgrep for dry-run matching
 * win32   PowerShell Get-Process | Stop-Process
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/killProcess.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "kill_process",
  description:
    "Terminates a process by name or PID. Use when a process is unresponsive " +
    "or consuming excessive resources. Always confirm with user before killing " +
    "critical system processes.",
  riskLevel:       "medium",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    name: z
      .string()
      .optional()
      .describe("Process name to kill (case-insensitive partial match)"),
    pid: z
      .number()
      .optional()
      .describe("Exact PID to kill. More precise than name"),
    signal: z
      .enum(["TERM", "KILL"])
      .optional()
      .describe("Signal to send. TERM=graceful shutdown, KILL=force. Default: TERM"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, show what would be killed without killing. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface MatchedProcess {
  pid:  number;
  name: string;
}

interface KillResult {
  matched: MatchedProcess[];
  killed:  boolean;
  dryRun:  boolean;
  signal:  string;
  message: string;
}

// -- Guards -------------------------------------------------------------------

const PROTECTED_NAMES = new Set(["kernel", "launchd", "systemd"]);

function isProtected(pid: number | undefined, name: string | undefined): boolean {
  if (pid === 1) return true;
  if (name && PROTECTED_NAMES.has(name.toLowerCase())) return true;
  return false;
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

// -- darwin implementation ----------------------------------------------------

async function killProcessDarwin(
  name:    string | undefined,
  pid:     number | undefined,
  signal:  string,
  dryRun:  boolean,
): Promise<KillResult> {
  const matched: MatchedProcess[] = [];

  if (pid !== undefined) {
    // Resolve process name for the given PID
    try {
      const { stdout } = await execAsync(
        `ps -p ${pid} -o comm= 2>/dev/null`,
        { maxBuffer: 1024 * 1024 },
      );
      const procName = stdout.trim().split("/").at(-1) ?? "";
      if (procName) matched.push({ pid, name: procName });
    } catch {
      // process may not exist
    }
  } else if (name) {
    const safeName = name.replace(/'/g, `'\\''`);
    try {
      const { stdout } = await execAsync(
        `pgrep -i -l '${safeName}' 2>/dev/null`,
        { maxBuffer: 1024 * 1024 },
      );
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const p     = parseInt(parts[0], 10);
        const n     = parts.slice(1).join(" ").split("/").at(-1) ?? parts[1] ?? "";
        if (!isNaN(p)) matched.push({ pid: p, name: n });
      }
    } catch {
      // no matches
    }
  }

  if (matched.length === 0) {
    return { matched, killed: false, dryRun, signal, message: "No matching processes found." };
  }

  // Check for protected processes
  for (const m of matched) {
    if (isProtected(m.pid, m.name)) {
      return {
        matched,
        killed:  false,
        dryRun,
        signal,
        message: `Refused: process '${m.name}' (PID ${m.pid}) is a protected system process.`,
      };
    }
  }

  if (dryRun) {
    return {
      matched,
      killed:  false,
      dryRun:  true,
      signal,
      message: `Dry run: would send SIG${signal} to ${matched.length} process(es).`,
    };
  }

  try {
    if (pid !== undefined) {
      await execAsync(`kill -${signal} ${pid} 2>/dev/null`);
    } else if (name) {
      const safeName = name.replace(/'/g, `'\\''`);
      await execAsync(`pkill -${signal} -i '${safeName}' 2>/dev/null`);
    }
    return {
      matched,
      killed:  true,
      dryRun:  false,
      signal,
      message: `Sent SIG${signal} to ${matched.length} process(es).`,
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { matched, killed: false, dryRun: false, signal, message: `Kill failed: ${msg}` };
  }
}

// -- win32 implementation -----------------------------------------------------

async function killProcessWin32(
  name:    string | undefined,
  pid:     number | undefined,
  signal:  string,
  dryRun:  boolean,
): Promise<KillResult> {
  const force = signal === "KILL" ? "-Force" : "";

  let listPs: string;
  if (pid !== undefined) {
    listPs = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Depth 1 -Compress`;
  } else {
    const safeName = (name ?? "").replace(/'/g, "''");
    listPs = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*${safeName}*' } | Select-Object Id,ProcessName | ConvertTo-Json -Depth 1 -Compress`;
  }

  const raw  = await runPS(listPs);
  if (!raw) {
    return { matched: [], killed: false, dryRun, signal, message: "No matching processes found." };
  }

  const parsed  = JSON.parse(raw) as { Id: number; ProcessName: string } | { Id: number; ProcessName: string }[];
  const arr     = Array.isArray(parsed) ? parsed : [parsed];
  const matched: MatchedProcess[] = arr.map(p => ({ pid: p.Id, name: p.ProcessName }));

  for (const m of matched) {
    if (isProtected(m.pid, m.name)) {
      return {
        matched,
        killed:  false,
        dryRun,
        signal,
        message: `Refused: process '${m.name}' (PID ${m.pid}) is a protected system process.`,
      };
    }
  }

  if (dryRun) {
    return {
      matched,
      killed:  false,
      dryRun:  true,
      signal,
      message: `Dry run: would stop ${matched.length} process(es).`,
    };
  }

  let stopPs: string;
  if (pid !== undefined) {
    stopPs = `Stop-Process -Id ${pid} ${force} -ErrorAction SilentlyContinue`;
  } else {
    const safeName = (name ?? "").replace(/'/g, "''");
    stopPs = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '*${safeName}*' } | Stop-Process ${force} -ErrorAction SilentlyContinue`;
  }

  try {
    await runPS(stopPs);
    return { matched, killed: true, dryRun: false, signal, message: `Stopped ${matched.length} process(es).` };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { matched, killed: false, dryRun: false, signal, message: `Stop failed: ${msg}` };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  name,
  pid,
  signal  = "TERM",
  dryRun  = true,
}: {
  name?:    string;
  pid?:     number;
  signal?:  "TERM" | "KILL";
  dryRun?:  boolean;
} = {}): Promise<KillResult> {
  if (!name && pid === undefined) {
    throw new Error("[kill_process] Must provide either 'name' or 'pid'.");
  }

  const platform = os.platform();
  if (platform === "win32") {
    return killProcessWin32(name, pid, signal, dryRun);
  }
  return killProcessDarwin(name, pid, signal, dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
