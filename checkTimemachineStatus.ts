/**
 * mcp/skills/checkTimemachineStatus.ts — check_timemachine_status skill
 *
 * macOS-only.  Reports Time Machine backup state via:
 *   - `tmutil latestbackup`     → path of the most recent backup snapshot
 *   - `tmutil status`           → current state (Running / Idle / FailedBackup)
 *   - `tmutil destinationinfo`  → configured destination(s)
 *
 * Telemetry contract (Track B Phase 4)
 * ------------------------------------
 * `meta.outputKeys` includes: platform, lastBackupMs, destination, status,
 * stale.  These are at the top level of the result so the proactive
 * evaluator's restricted DSL can reference them.  Trigger 5 fires when
 * `stale == true` — i.e. the most recent backup is older than the
 * configured threshold (default 72 h).
 *
 * Read-only.
 *
 * Windows behaviour
 * -----------------
 * Time Machine is a macOS-only feature.  On win32 the tool returns:
 *   { platform: "win32", status: "not-supported", stale: false, ... }
 * Trigger 5 in Wave 2 declares no Windows variant; this is intentional —
 * Windows backup landscape is fragmented (File History, Windows Backup,
 * Microsoft Backup app, third-party tools).  A future tool can probe
 * those individually.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  isDarwin,
  isWin32,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_timemachine_status",
  description:
    "Reports the current Time Machine backup state on macOS — last-backup " +
    "timestamp, configured destination, current status, and a `stale` flag " +
    "set when the most recent backup is older than the configured " +
    "threshold (default 72h). Used both by the user-facing Cloud Sync & " +
    "Backup repair skill and as the telemetry source for the proactive " +
    "timemachine-stale trigger. Returns status: 'not-supported' on Windows.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  outputKeys: [
    "platform",
    "lastBackupMs",
    "destination",
    "status",
    "stale",
  ],
  schema: {
    staleThresholdHours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .optional()
      .describe("Hours since last successful backup that count as stale. Default 72 (3 days)."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export type TimemachineStatus =
  | "running"
  | "idle"
  | "failed"
  | "no-destination"
  | "stale"
  | "not-supported"
  | "unknown";

export interface CheckTimemachineStatusResult {
  platform:      NodeJS.Platform;
  lastBackupMs:  number | null;
  /** Most recent backup snapshot path. */
  lastBackupPath: string | null;
  /** Configured destination volume name (or path).  null when none configured. */
  destination:   string | null;
  status:        TimemachineStatus;
  stale:         boolean;
  /** Diagnostic message for the user — short. */
  message:       string;
}

const DEFAULT_STALE_HOURS = 72;

// -- darwin parsing helpers ---------------------------------------------------

/**
 * `tmutil latestbackup` outputs lines like:
 *   /Volumes/Backup/Backups.backupdb/Mac/2026-04-23-101500
 * The trailing component is the snapshot folder named YYYY-MM-DD-HHMMSS.
 */
function parseLatestBackupPath(stdout: string): { path: string | null; mtimeMs: number | null } {
  const trimmed = stdout.trim();
  if (!trimmed) return { path: null, mtimeMs: null };

  // Take the last line in case multiple are returned.
  const line   = trimmed.split("\n").pop()!;
  const match  = line.match(/(\d{4}-\d{2}-\d{2}-\d{6})/);
  if (!match) return { path: line, mtimeMs: null };

  // YYYY-MM-DD-HHMMSS in local time.  The user-visible mtime of the
  // snapshot directory is more accurate than parsing the name (snapshots
  // can be renamed by the user), but parsing the name avoids needing a
  // separate `stat` call when tmutil is responsive.
  const ts = match[1];
  const yyyy = parseInt(ts.slice(0, 4),  10);
  const mm   = parseInt(ts.slice(5, 7),  10);
  const dd   = parseInt(ts.slice(8, 10), 10);
  const hh   = parseInt(ts.slice(11,13), 10);
  const mi   = parseInt(ts.slice(13,15), 10);
  const ss   = parseInt(ts.slice(15,17), 10);
  const date = new Date(yyyy, mm - 1, dd, hh, mi, ss);
  const mtimeMs = date.getTime();
  return { path: line, mtimeMs: Number.isNaN(mtimeMs) ? null : mtimeMs };
}

/**
 * `tmutil status` output is plist-formatted, with key fields:
 *   Running          1 | 0
 *   ClientID         "com.apple.backupd"
 *   BackupPhase      "Copying" | "FindingChanges" | "ThinningPostBackup" | …
 *   Percent          0.0 - 1.0
 *   Stopping         0
 * We only need the Running flag and the BackupPhase for a coarse
 * classification.
 */
function parseTmutilStatus(stdout: string): { running: boolean; phase: string | null; failed: boolean } {
  const lines      = stdout.split("\n").map((l) => l.trim());
  const runningRe  = /Running\s*=\s*(\d)/;
  const phaseRe    = /BackupPhase\s*=\s*"?([^"]+?)"?\s*;?$/;
  const failedHint = /(failedBackup|FailedSetup|InvalidDest|Error)/i;

  let running = false;
  let phase: string | null = null;
  let failed = false;

  for (const line of lines) {
    const r = line.match(runningRe);
    if (r) running = r[1] === "1";
    const p = line.match(phaseRe);
    if (p) phase = p[1];
    if (failedHint.test(line)) failed = true;
  }
  return { running, phase, failed };
}

/**
 * `tmutil destinationinfo` lists configured destinations.  We only need
 * the first one's "Name" field (or "URL" / "Mount Point" as a fallback).
 */
function parseDestinationInfo(stdout: string): string | null {
  const lines = stdout.split("\n").map((l) => l.trim());
  for (const line of lines) {
    const nameMatch = line.match(/^Name\s*:\s*(.+)$/);
    if (nameMatch) return nameMatch[1].trim();
  }
  for (const line of lines) {
    const mountMatch = line.match(/^Mount Point\s*:\s*(.+)$/);
    if (mountMatch) return mountMatch[1].trim();
  }
  return null;
}

// -- Status computation -------------------------------------------------------

interface StatusInputs {
  running:      boolean;
  phase:        string | null;
  failed:       boolean;
  destination:  string | null;
  lastBackupMs: number | null;
  staleMs:      number;
}

function computeStatus(inputs: StatusInputs): { status: TimemachineStatus; stale: boolean; message: string } {
  if (!inputs.destination) {
    return { status: "no-destination", stale: false, message: "No Time Machine destination is configured." };
  }
  if (inputs.failed) {
    return { status: "failed", stale: true, message: "Time Machine reported a failed backup." };
  }
  if (inputs.running) {
    return {
      status: "running",
      stale:  false,
      message: inputs.phase ? `Backup running — phase: ${inputs.phase}` : "Backup currently running.",
    };
  }
  if (inputs.lastBackupMs === null) {
    return {
      status: "unknown",
      stale:  false,
      message: "Unable to determine last backup time. tmutil returned no usable output.",
    };
  }
  const ageMs = Date.now() - inputs.lastBackupMs;
  if (ageMs >= inputs.staleMs) {
    const ageHours = Math.round(ageMs / (60 * 60 * 1000));
    return {
      status: "stale",
      stale:  true,
      message: `Last backup is ${ageHours}h old, beyond the ${Math.round(inputs.staleMs / (60 * 60 * 1000))}h threshold.`,
    };
  }
  return { status: "idle", stale: false, message: "Time Machine is up to date." };
}

// -- darwin implementation ----------------------------------------------------

async function checkTimemachineDarwin(staleMs: number): Promise<CheckTimemachineStatusResult> {
  // Run all three tmutil probes in parallel.  Each is independently
  // non-fatal — if one fails we degrade the corresponding field rather
  // than aborting.
  const [latestRes, statusRes, destRes] = await Promise.allSettled([
    execAsync("tmutil latestbackup 2>/dev/null", { timeout: 10_000 }),
    execAsync("tmutil status 2>/dev/null",       { timeout: 10_000 }),
    execAsync("tmutil destinationinfo 2>/dev/null", { timeout: 10_000 }),
  ]);

  const latestStdout = latestRes.status === "fulfilled" ? latestRes.value.stdout : "";
  const statusStdout = statusRes.status === "fulfilled" ? statusRes.value.stdout : "";
  const destStdout   = destRes.status   === "fulfilled" ? destRes.value.stdout   : "";

  const { path: lastBackupPath, mtimeMs: lastBackupMs } = parseLatestBackupPath(latestStdout);
  const { running, phase, failed } = parseTmutilStatus(statusStdout);
  const destination = parseDestinationInfo(destStdout);

  const { status, stale, message } = computeStatus({
    running, phase, failed, destination, lastBackupMs, staleMs,
  });

  return {
    platform:       "darwin",
    lastBackupMs,
    lastBackupPath,
    destination,
    status,
    stale,
    message,
  };
}

// -- win32 implementation -----------------------------------------------------

function checkTimemachineWin32(): CheckTimemachineStatusResult {
  return {
    platform:       "win32",
    lastBackupMs:   null,
    lastBackupPath: null,
    destination:    null,
    status:         "not-supported",
    stale:          false,
    message:        "Time Machine is a macOS-only feature. Use Windows Backup or File History on this platform.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  staleThresholdHours = DEFAULT_STALE_HOURS,
}: {
  staleThresholdHours?: number;
} = {}): Promise<CheckTimemachineStatusResult> {
  const platform = os.platform();
  if (isDarwin()) {
    const staleMs = staleThresholdHours * 60 * 60 * 1000;
    return checkTimemachineDarwin(staleMs);
  }
  if (isWin32()) {
    return checkTimemachineWin32();
  }
  throw new Error(`check_timemachine_status: unsupported platform "${platform}"`);
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  parseLatestBackupPath,
  parseTmutilStatus,
  parseDestinationInfo,
  computeStatus,
  checkTimemachineDarwin,
  checkTimemachineWin32,
};
