/**
 * mcp/skills/syncSystemTime.ts — sync_system_time
 *
 * Forces an immediate NTP resync.  The identity-auth-repair skill calls
 * this after check_ntp_status reports significant drift.
 *
 * Platform strategy
 * -----------------
 * darwin  `sudo sntp -sS <server>` — requires admin; writes the clock.
 * win32   `w32tm /resync /force`  — requires admin; nudges W32Time to
 *         re-query its time source.
 *
 * Large time jumps can trigger endpoint security software alerts and
 * break TLS sessions mid-flight — hence requiresConsent + supportsDryRun.
 * Dry-run reports the exact command that would run.
 */

import { z } from "zod";

import { execAsync, isDarwin, isWin32 } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "sync_system_time",
  description:
    "Forces an immediate NTP clock resync on the endpoint. Use ONLY after " +
    "check_ntp_status reports significant drift. Requires admin privileges. " +
    "Large time jumps can break in-flight TLS sessions and trigger endpoint " +
    "security software alerts — always run dry-run first so the user can see " +
    "the command.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  schema: {
    server: z
      .string()
      .optional()
      .describe(
        "Reference NTP server. Defaults to 'time.apple.com' on macOS, " +
        "the configured peer on Windows.",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe("When true, report the command that would run without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface SyncTimeResult {
  platform: "darwin" | "win32" | "other";
  command:  string;
  dryRun:   boolean;
  success:  boolean;
  stdout?:  string;
  error?:   string;
  message:  string;
}

// -- Implementation -----------------------------------------------------------

async function syncDarwin(server: string, dryRun: boolean): Promise<SyncTimeResult> {
  const command = `sudo sntp -sS ${shellQuote(server)}`;
  if (dryRun) {
    return {
      platform: "darwin", command, dryRun: true, success: true,
      message: `Would run \`${command}\` (requires admin). No changes yet.`,
    };
  }
  try {
    const { stdout } = await execAsync(command, {
      maxBuffer: 1 * 1024 * 1024, timeout: 10_000,
    });
    return {
      platform: "darwin", command, dryRun: false, success: true,
      stdout,
      message: `System clock resync requested via ${server}.`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      platform: "darwin", command, dryRun: false, success: false,
      error: msg,
      message: formatSyncError("darwin", msg, command),
    };
  }
}

async function syncWin32(dryRun: boolean): Promise<SyncTimeResult> {
  const command = `w32tm /resync /force`;
  if (dryRun) {
    return {
      platform: "win32", command, dryRun: true, success: true,
      message: `Would run \`${command}\` (requires admin). No changes yet.`,
    };
  }
  try {
    const { stdout } = await execAsync(command, {
      maxBuffer: 1 * 1024 * 1024, timeout: 10_000,
    });
    return {
      platform: "win32", command, dryRun: false, success: true,
      stdout,
      message: `Windows Time service resync requested.`,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      platform: "win32", command, dryRun: false, success: false,
      error: msg,
      message: formatSyncError("win32", msg, command),
    };
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Maps a raw error message to a user-friendly guidance message per
 * platform.  Extracted so the branch logic can be unit-tested without
 * mocking execAsync rejections (which vitest 4 flags as unhandled
 * rejections even inside try/catch).
 */
export function formatSyncError(platform: "darwin" | "win32", msg: string, command: string): string {
  if (platform === "darwin") {
    return /sudo/i.test(msg)
      ? `sudo authentication required. Ask the user to run \`${command}\` manually, or re-run this with elevated privileges.`
      : `sntp failed: ${msg}`;
  }
  if (/access is denied/i.test(msg) || /^5:/.test(msg)) {
    return `Admin rights required. Open an elevated Command Prompt and run \`${command}\`.`;
  }
  return `w32tm /resync /force failed: ${msg}`;
}

// Exported for unit tests.
export const __testing = { syncDarwin, syncWin32 };

// -- Exported run function ----------------------------------------------------

export async function run({
  server,
  dryRun = false,
}: {
  server?: string;
  dryRun?: boolean;
} = {}): Promise<SyncTimeResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  if (platform === "darwin") {
    return syncDarwin(server ?? "time.apple.com", dryRun);
  }
  if (platform === "win32") {
    return syncWin32(dryRun);
  }

  return {
    platform: "other", command: "(unsupported)", dryRun, success: false,
    message: "Unsupported platform — cannot sync system time.",
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
