/**
 * mcp/skills/restartCups.ts — restart_cups skill
 *
 * Restarts the CUPS (Common Unix Printing System) print service on macOS
 * or the Print Spooler on Windows.  Use when printers are not discoverable,
 * queue management is broken, or after adding/removing printers.
 *
 * Platform strategy
 * -----------------
 * darwin  `lpstat -r` to check status; `sudo launchctl stop/start org.cups.cupsd`
 * win32   PowerShell Get-Service Spooler; Restart-Service -Name Spooler -Force
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/restartCups.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "restart_cups",
  description:
    "Restarts the CUPS (Common Unix Printing System) print service on macOS " +
    "or the Print Spooler on Windows. " +
    "Use when printers are not discoverable, queue management is broken, " +
    "or after adding/removing printers.",
  riskLevel:       "medium",
  // Restarting the print service interrupts any in-flight job and resets system
  // print state, so destructive:true. This also makes G4 auto-fire the dry-run
  // preview + consent flow (autoTriggerDryRun = supportsDryRun && (riskLevel>=high
  // || destructive)); without it the tool's dryRun:true default wins and the
  // restart never runs.
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo launchctl kickstart -k system/org.cups.cupsd",
    win32:  "Restart-Service Spooler -Force  # run from elevated PowerShell",
  },
  schema: {
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("If true, check service status without restarting. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RestartCupsResult {
  wasRunning:  boolean;
  restarted:   boolean;
  isRunning:   boolean;
  dryRun:      boolean;
  platform:    string;
  message:     string;
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

async function restartCupsDarwin(dryRun: boolean): Promise<RestartCupsResult> {
  // Check current status with lpstat -r
  let wasRunning = false;
  try {
    const { stdout } = await execAsync("lpstat -r");
    wasRunning = stdout.toLowerCase().includes("scheduler is running");
  } catch {
    wasRunning = false;
  }

  let restarted = false;
  if (!dryRun) {
    try {
      // `launchctl kickstart -k system/org.cups.cupsd` restarts the daemon in
      // one call. The older `launchctl stop`/`start` pair silently no-ops for
      // protected system daemons on macOS 14.4+ (Sonoma) and later — even as
      // root — so it can't be relied on. kickstart -k is the supported restart
      // path. Needs root: provided by the privileged helper daemon (the direct
      // `sudo` here is only reached on a non-helper/elevated path).
      await execAsync("sudo launchctl kickstart -k system/org.cups.cupsd");
      restarted = true;
    } catch {
      restarted = false;
    }
  }

  // Re-check status after restart
  let isRunning = wasRunning;
  if (!dryRun) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const { stdout } = await execAsync("lpstat -r");
      isRunning = stdout.toLowerCase().includes("scheduler is running");
    } catch {
      isRunning = false;
    }
  }

  const message = dryRun
    ? `CUPS scheduler is currently ${wasRunning ? "running" : "stopped"}. Run with dryRun=false to restart.`
    : restarted
      ? `CUPS restarted successfully. Scheduler is now ${isRunning ? "running" : "stopped"}.`
      : "Failed to restart CUPS. You may need to run with sudo privileges.";

  return { wasRunning, restarted, isRunning, dryRun, platform: "darwin", message };
}

// -- win32 implementation -----------------------------------------------------

async function restartCupsWin32(dryRun: boolean): Promise<RestartCupsResult> {
  // Check Print Spooler status
  let wasRunning = false;
  try {
    const raw = await runPS(
      `Get-Service Spooler | Select-Object -ExpandProperty Status`,
    );
    wasRunning = raw.trim().toLowerCase() === "running";
  } catch {
    wasRunning = false;
  }

  let restarted = false;
  if (!dryRun) {
    try {
      await runPS("Restart-Service -Name Spooler -Force");
      restarted = true;
    } catch {
      restarted = false;
    }
  }

  // Re-check status
  let isRunning = wasRunning;
  if (!dryRun) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const raw = await runPS(
        `Get-Service Spooler | Select-Object -ExpandProperty Status`,
      );
      isRunning = raw.trim().toLowerCase() === "running";
    } catch {
      isRunning = false;
    }
  }

  const message = dryRun
    ? `Print Spooler is currently ${wasRunning ? "running" : "stopped"}. Run with dryRun=false to restart.`
    : restarted
      ? `Print Spooler restarted successfully. Service is now ${isRunning ? "running" : "stopped"}.`
      : "Failed to restart Print Spooler. Ensure you have administrator privileges.";

  return { wasRunning, restarted, isRunning, dryRun, platform: "win32", message };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? restartCupsWin32(dryRun)
    : restartCupsDarwin(dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
