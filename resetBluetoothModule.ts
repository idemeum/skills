/**
 * mcp/skills/resetBluetoothModule.ts — reset_bluetooth_module skill
 *
 * Restarts the Bluetooth daemon / service so the OS re-enumerates paired
 * devices and re-establishes connections.  Used as a last-resort fix
 * when devices are paired-but-disconnected, after toggling the device
 * itself failed.
 *
 * Platform strategy
 * -----------------
 * darwin  `sudo -n /bin/launchctl kickstart -k system/com.apple.bluetoothd`
 *         restarts the system bluetoothd.  Requires admin — the G4
 *         scope-boundary check (`affectedScope: ["system"]`) blocks
 *         non-admin runs by aborting the step.
 * win32   `Restart-Service -Name bthserv -Force` via elevated
 *         PowerShell.  Same admin requirement.
 *
 * Both restarts are ASYNCHRONOUS — the command returns the moment the
 * request is accepted, while the radio stays down for several more
 * seconds.  `succeeded` therefore derives from a bounded poll of the
 * real radio state, never from the command's exit code.
 *
 * Dry-run: returns the exact command(s) that would run.  Does NOT touch
 * the system in dry-run mode.
 *
 * Notes on side effects
 * ---------------------
 *   - Active connections drop for 2–5 s.  A user on a Bluetooth audio
 *     call will hear the audio interrupt.
 *   - Bluetooth-input devices (keyboard, trackpad) reconnect within the
 *     same window; the user may temporarily lose input.  This is why the
 *     skill always surfaces the dry-run preview + consent gate.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  runPS,
  isDarwin,
  isWin32,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reset_bluetooth_module",
  description:
    "Restarts the system Bluetooth daemon (macOS bluetoothd / Windows bthserv) " +
    "so the OS re-enumerates paired devices and re-establishes connections. " +
    "Last-resort fix for paired-but-disconnected devices when toggling the " +
    "device itself has failed. Requires admin privilege; will briefly drop " +
    "all Bluetooth connections including any audio call in progress.",
  riskLevel:       "medium",
  // Restarting the Bluetooth daemon drops every active connection — including
  // the user's keyboard / trackpad — so destructive:true. It also makes G4
  // auto-fire the dry-run preview + consent flow (autoTriggerDryRun =
  // supportsDryRun && (riskLevel >= high || destructive)); without it the
  // consent gate fires with rationale text only and the user never sees the
  // command or the connection-drop warning before approving.
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  // Covers the kickstart plus the bounded settle poll below; must clear G4's
  // TOOL_TIMEOUT_MS so the poll isn't killed mid-restart.
  timeoutMs:       90_000,
  escalationHint:  {
    darwin: "sudo /bin/launchctl kickstart -k system/com.apple.bluetoothd",
    win32:  "Restart-Service -Name bthserv -Force  # run from elevated PowerShell",
  },
  outputKeys: ["platform","dryRun","command","succeeded","settled","message","durationMs"],
  schema: {
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("If true, report what would be restarted without touching the system."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface ResetBluetoothModuleResult {
  platform:      NodeJS.Platform;
  dryRun:        boolean;
  command:       string;
  /**
   * True only when the daemon was restarted AND the radio came back up
   * within the settle budget.  Never set from "the restart command exited
   * 0" alone — the restart is asynchronous and the radio is down for
   * several seconds afterwards.
   */
  succeeded:     boolean;
  /**
   * Whether the radio reached its terminal (powered-on) state before the
   * settle deadline.  `false` with `succeeded: false` after a clean restart
   * means "still coming back up", which is not the same as a failed reset.
   */
  settled:       boolean;
  /** Diagnostic message — usually a stderr line on failure, or a confirmation on success. */
  message:       string;
  durationMs?:   number;
}

// -- Platform helpers ---------------------------------------------------------

// `-n` is load-bearing: without it sudo prompts for a password on a TTY the
// Electron child process does not have, and the call hangs until the timeout.
// The privileged helper daemon is the real path for this tool
// (affectedScope: ["system"]); this local command is the fallback for a
// machine where the agent already holds admin.
const DARWIN_CMD = "sudo -n /bin/launchctl kickstart -k system/com.apple.bluetoothd";
const WIN_CMD    = "Restart-Service -Name bthserv -Force";

/** Bounded settle poll — the radio typically returns in 2–5 s. */
const SETTLE_DEADLINE_MS = 20_000;
const SETTLE_INTERVAL_MS = 1_500;

function isPermissionFailure(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("permission denied") ||
    s.includes("not permitted") ||
    s.includes("access is denied") ||
    s.includes("requires administrative") ||
    s.includes("must be run as administrator") ||
    s.includes("needed root privileges") ||
    s.includes("a password is required")
  );
}

/** True when the OS reports the Bluetooth radio powered on, right now. */
async function probeRadioOn(): Promise<boolean> {
  try {
    if (isDarwin()) {
      const { stdout } = await execAsync(
        "system_profiler SPBluetoothDataType -json 2>/dev/null",
        { timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
      );
      // macOS 13+ reports "attrib_on"; older builds reported "On".
      return /"controller_state"\s*:\s*"(attrib_on|On)"/i.test(stdout);
    }
    const stdout = await runPS(
      `$ErrorActionPreference='SilentlyContinue'
$svc = Get-Service -Name bthserv -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { 'on' } else { 'off' }`,
      { timeoutMs: 10_000 },
    );
    return stdout.trim().toLowerCase() === "on";
  } catch {
    return false;
  }
}

/**
 * Both platform restarts are fire-and-forget: the command returns as soon
 * as the request is accepted, while the radio stays down for several more
 * seconds.  Poll until it is actually back before reporting success (see
 * SKILL-AUDIT-CHECKLIST § 10i).
 */
async function waitForRadio(deadlineAt: number): Promise<boolean> {
  for (;;) {
    if (await probeRadioOn()) return true;
    if (Date.now() >= deadlineAt) return false;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_INTERVAL_MS));
  }
}

interface ExecOutcome {
  /** The restart command itself was accepted (says nothing about the radio). */
  issued:     boolean;
  message:    string;
  durationMs: number;
}

async function executeDarwin(): Promise<ExecOutcome> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(DARWIN_CMD, { timeout: 15_000 });
    const elapsed = Date.now() - start;
    if (stderr && isPermissionFailure(stderr)) {
      return { issued: false, message: stderr.trim(), durationMs: elapsed };
    }
    return {
      issued:  true,
      message: stdout.trim() || "bluetoothd restarted via launchctl kickstart",
      durationMs: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = (err as Error).message;
    return { issued: false, message: msg, durationMs: elapsed };
  }
}

async function executeWin32(): Promise<ExecOutcome> {
  const start = Date.now();
  try {
    const stdout = await runPS(`$ErrorActionPreference='Stop'; ${WIN_CMD}; 'OK'`, { timeoutMs: 15_000 });
    const elapsed = Date.now() - start;
    if (stdout.trim().toLowerCase().endsWith("ok")) {
      return { issued: true, message: "bthserv restarted via Restart-Service", durationMs: elapsed };
    }
    return { issued: false, message: stdout.trim() || "Restart-Service returned no output", durationMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = (err as Error).message;
    return { issued: false, message: msg, durationMs: elapsed };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = false,
}: { dryRun?: boolean } = {}): Promise<ResetBluetoothModuleResult> {
  const platform = os.platform();

  if (!isDarwin() && !isWin32()) {
    throw new Error(`reset_bluetooth_module: unsupported platform "${platform}"`);
  }

  const command = isDarwin() ? DARWIN_CMD : WIN_CMD;

  if (dryRun) {
    return {
      platform,
      dryRun:    true,
      command,
      succeeded: true,
      settled:   true,
      message:
        `Would restart the Bluetooth daemon. ` +
        `Active Bluetooth connections (audio, keyboards, mice) will drop ` +
        `for 2–5 seconds while the daemon restarts. Requires admin privilege.`,
    };
  }

  const start   = Date.now();
  const outcome = isDarwin() ? await executeDarwin() : await executeWin32();

  if (!outcome.issued) {
    return {
      platform,
      dryRun:    false,
      command,
      succeeded: false,
      settled:   false,
      message:   outcome.message,
      durationMs: outcome.durationMs,
    };
  }

  const settled = await waitForRadio(Date.now() + SETTLE_DEADLINE_MS);
  return {
    platform,
    dryRun:    false,
    command,
    succeeded: settled,
    settled,
    message: settled
      ? `${outcome.message}. Radio is back up — paired devices reconnect on their own over the next few seconds.`
      : `The restart command was accepted but the Bluetooth radio had not come ` +
        `back up after ${Math.round(SETTLE_DEADLINE_MS / 1000)} seconds. Wait a moment and ` +
        `re-check; if it stays down, toggle Bluetooth off and on from the menu bar ` +
        `(macOS) or Quick Settings (Windows), or restart the machine.`,
    durationMs: Date.now() - start,
  };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  isPermissionFailure,
  probeRadioOn,
  waitForRadio,
  DARWIN_CMD,
  WIN_CMD,
  SETTLE_DEADLINE_MS,
  SETTLE_INTERVAL_MS,
};
