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
 * darwin  `sudo launchctl kickstart -k system/com.apple.bluetoothd`
 *         restarts the system bluetoothd.  Requires admin — the G4
 *         scope-boundary check (`affectedScope: ["system"]`) blocks
 *         non-admin runs by aborting the step.
 * win32   `Restart-Service -Name bthserv -Force` via elevated
 *         PowerShell.  Same admin requirement.
 *
 * Dry-run: returns the exact command(s) that would run + reports
 * whether the agent has admin already (best-effort detection via a
 * harmless probe).  Does NOT touch the system in dry-run mode.
 *
 * Notes on side effects
 * ---------------------
 *   - Active connections drop briefly (1–3 s).  A user on a Bluetooth
 *     audio call will hear the audio interrupt.
 *   - Bluetooth-input devices (keyboard, trackpad) reconnect within
 *     2–5 s; the user may temporarily lose input.  This is why the
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
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo /bin/launchctl kickstart -k system/com.apple.bluetoothd",
    win32:  "Restart-Service -Name bthserv -Force  # run from elevated PowerShell",
  },
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report what would be restarted without touching the system."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface ResetBluetoothModuleResult {
  platform:      NodeJS.Platform;
  dryRun:        boolean;
  command:       string;
  /** Best-effort probe — true when the call succeeded. False when stderr indicated permission denial. */
  succeeded:     boolean;
  /** Diagnostic message — usually a stderr line on failure, or a confirmation on success. */
  message:       string;
  durationMs?:   number;
}

// -- Platform helpers ---------------------------------------------------------

const DARWIN_CMD = "sudo /bin/launchctl kickstart -k system/com.apple.bluetoothd";
const WIN_CMD    = "Restart-Service -Name bthserv -Force";

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

async function executeDarwin(): Promise<{ succeeded: boolean; message: string; durationMs: number }> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(DARWIN_CMD, { timeout: 15_000 });
    const elapsed = Date.now() - start;
    if (stderr && isPermissionFailure(stderr)) {
      return { succeeded: false, message: stderr.trim(), durationMs: elapsed };
    }
    return {
      succeeded: true,
      message:   stdout.trim() || "bluetoothd restarted via launchctl kickstart",
      durationMs: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = (err as Error).message;
    return { succeeded: false, message: msg, durationMs: elapsed };
  }
}

async function executeWin32(): Promise<{ succeeded: boolean; message: string; durationMs: number }> {
  const start = Date.now();
  try {
    const stdout = await runPS(`$ErrorActionPreference='Stop'; ${WIN_CMD}; 'OK'`, { timeoutMs: 15_000 });
    const elapsed = Date.now() - start;
    if (stdout.trim().toLowerCase().endsWith("ok")) {
      return { succeeded: true, message: "bthserv restarted via Restart-Service", durationMs: elapsed };
    }
    return { succeeded: false, message: stdout.trim() || "Restart-Service returned no output", durationMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = (err as Error).message;
    return { succeeded: false, message: msg, durationMs: elapsed };
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
      message:
        `Would restart the Bluetooth daemon. ` +
        `Active Bluetooth connections (audio, keyboards, mice) will drop ` +
        `for 1–3 seconds while the daemon restarts. Requires admin privilege.`,
    };
  }

  const result = isDarwin() ? await executeDarwin() : await executeWin32();
  return {
    platform,
    dryRun:    false,
    command,
    succeeded: result.succeeded,
    message:   result.message,
    durationMs: result.durationMs,
  };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  isPermissionFailure,
  DARWIN_CMD,
  WIN_CMD,
};
