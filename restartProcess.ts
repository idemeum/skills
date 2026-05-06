/**
 * mcp/skills/restartProcess.ts — restart_process skill
 *
 * Terminates a process by name or PID, waits briefly, then re-launches it.
 * Use when a process is hung or unresponsive but needs to keep running
 * (e.g. security agent, VPN client, Finder).
 *
 * Platform strategy
 * -----------------
 * darwin  `kill -TERM {pid}` then optionally `open -a {name}` or exec launchPath
 * win32   PowerShell Stop-Process then Start-Process
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/restartProcess.ts --name Finder
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "restart_process",
  description:
    "Terminates a process by name or PID, waits briefly, then re-launches it. " +
    "Use when a process is hung or unresponsive but needs to keep running " +
    "(e.g. security agent, VPN client, Finder).",
  riskLevel:       "medium",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    name: z
      .string()
      .optional()
      .describe("Process name to restart (e.g. 'Finder', 'CrowdStrikeFalconSensor')"),
    pid: z
      .number()
      .optional()
      .describe("Process ID to restart. Use instead of name for precision"),
    launchPath: z
      .string()
      .optional()
      .describe("Full path to re-launch after killing. Required if process doesn't relaunch itself."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RestartResult {
  killed:     boolean;
  relaunched: boolean;
  newPid:     number | null;
  message:    string;
}

// -- Helpers ------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Validate a process name — only allow simple identifiers to prevent injection. */
function validateName(name: string): boolean {
  return /^[a-zA-Z0-9_\-. ]+$/.test(name);
}

/** Validate a launch path — must be absolute and not contain shell metacharacters. */
function validateLaunchPath(p: string): boolean {
  return nodePath.isAbsolute(p) && /^[a-zA-Z0-9_\-./: ]+$/.test(p);
}

import * as nodePath from "path";

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

async function getFirstPidByName(name: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `pgrep -n -x '${name.replace(/'/g, "'\\''")}' 2>/dev/null`,
    );
    const pid = parseInt(stdout.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

async function restartProcessDarwin(
  name:       string | undefined,
  pid:        number | undefined,
  launchPath: string | undefined,
): Promise<RestartResult> {
  // Resolve PID
  let targetPid = pid ?? null;
  if (!targetPid && name) {
    if (!validateName(name)) {
      throw new Error(`[restart_process] Invalid process name: ${name}`);
    }
    targetPid = await getFirstPidByName(name);
  }

  if (!targetPid) {
    return {
      killed:     false,
      relaunched: false,
      newPid:     null,
      message:    name ? `No running process found with name: ${name}` : "No PID or name provided",
    };
  }

  // Kill the process
  let killed = false;
  try {
    await execAsync(`kill -TERM ${targetPid} 2>&1`);
    killed = true;
  } catch (err) {
    return {
      killed:     false,
      relaunched: false,
      newPid:     null,
      message:    `Failed to terminate PID ${targetPid}: ${(err as Error).message}`,
    };
  }

  // Brief pause to allow process to clean up
  await sleep(1500);

  // Relaunch
  if (launchPath) {
    if (!validateLaunchPath(launchPath)) {
      return { killed, relaunched: false, newPid: null, message: `Invalid launch path: ${launchPath}` };
    }
    try {
      const { stdout } = await execAsync(`'${launchPath.replace(/'/g, "'\\''")}' &`);
      const newPid = parseInt(stdout.trim(), 10);
      return {
        killed,
        relaunched: true,
        newPid:     isNaN(newPid) ? null : newPid,
        message:    `Process killed and re-launched via ${launchPath}`,
      };
    } catch (err) {
      return { killed, relaunched: false, newPid: null, message: `Killed but relaunch failed: ${(err as Error).message}` };
    }
  }

  if (name) {
    if (!validateName(name)) {
      return { killed, relaunched: false, newPid: null, message: `Process killed. Invalid name for relaunch.` };
    }
    try {
      await execAsync(`open -a '${name.replace(/'/g, "'\\''")}' 2>&1`);
      await sleep(1000);
      const newPid = await getFirstPidByName(name);
      return {
        killed,
        relaunched: true,
        newPid:     newPid ?? null,
        message:    `Process killed and re-launched via 'open -a ${name}'`,
      };
    } catch (err) {
      return {
        killed,
        relaunched: false,
        newPid:     null,
        message:    `Killed PID ${targetPid} but relaunch via open -a failed: ${(err as Error).message}`,
      };
    }
  }

  return {
    killed,
    relaunched: false,
    newPid:     null,
    message:    `Killed PID ${targetPid}. No launchPath or name provided for relaunch.`,
  };
}

// -- win32 implementation -----------------------------------------------------

async function restartProcessWin32(
  name:       string | undefined,
  pid:        number | undefined,
  launchPath: string | undefined,
): Promise<RestartResult> {
  if (!name && !pid) {
    return { killed: false, relaunched: false, newPid: null, message: "No PID or name provided" };
  }
  if (name && !validateName(name)) {
    throw new Error(`[restart_process] Invalid process name: ${name}`);
  }

  const stopTarget = pid ? `-Id ${pid}` : `-Name '${name!.replace(/'/g, "''")}'`;

  const stopPs = `
$ErrorActionPreference = 'Stop'
Stop-Process ${stopTarget} -Force
Write-Output 'killed'`.trim();

  let killed = false;
  try {
    const out = await runPS(stopPs);
    killed    = out.includes("killed");
  } catch (err) {
    return {
      killed:     false,
      relaunched: false,
      newPid:     null,
      message:    `Failed to stop process: ${(err as Error).message}`,
    };
  }

  await sleep(1500);

  if (!launchPath && !name) {
    return { killed, relaunched: false, newPid: null, message: `Process killed. No launch path for relaunch.` };
  }

  const startCmd = launchPath
    ? `Start-Process -FilePath '${launchPath.replace(/'/g, "''")}' -PassThru`
    : `Start-Process -FilePath '${name!.replace(/'/g, "''")}' -PassThru`;

  const launchPs = `
$ErrorActionPreference = 'Stop'
$p = ${startCmd}
$p.Id`.trim();

  try {
    const out    = await runPS(launchPs);
    const newPid = parseInt(out.trim(), 10);
    return {
      killed,
      relaunched: true,
      newPid:     isNaN(newPid) ? null : newPid,
      message:    `Process killed and re-launched`,
    };
  } catch (err) {
    return {
      killed,
      relaunched: false,
      newPid:     null,
      message:    `Killed but relaunch failed: ${(err as Error).message}`,
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  name,
  pid,
  launchPath,
}: {
  name?:       string;
  pid?:        number;
  launchPath?: string;
} = {}) {
  if (!name && !pid) {
    throw new Error("[restart_process] Either name or pid must be provided");
  }

  const platform = os.platform();
  return platform === "win32"
    ? restartProcessWin32(name, pid, launchPath)
    : restartProcessDarwin(name, pid, launchPath);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
