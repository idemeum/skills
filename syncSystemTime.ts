/**
 * mcp/skills/syncSystemTime.ts — sync_system_time
 *
 * Forces an immediate NTP resync.  The identity-auth-repair skill calls
 * this after check_ntp_status reports significant drift.
 *
 * Privilege model
 * ---------------
 * NTP clock writes require admin / LocalSystem privilege.  The agent runs
 * as the standard user; G4 routes this tool through the privileged helper
 * daemon (Workstream D — sync_system_time handler) so non-admin users
 * complete the resync end-to-end without an interactive sudo prompt.
 * When the helper is unavailable (HELPER_DAEMON_ENABLED=false / not
 * installed / unreachable), the call denies with helper-error /
 * helper-unavailable / scope-boundary; the agent surfaces the dry-run
 * preview (which formats `formatSyncError` guidance) so the user can run
 * the command manually as a last resort.
 *
 * Platform strategy
 * -----------------
 * darwin  helper runs `sntp -sS <server>` (default `time.apple.com`)
 * win32   helper runs `w32tm /resync /force` (server param ignored —
 *         W32Time reads from its configured peer)
 *
 * Large time jumps can trigger endpoint security software alerts and
 * break TLS sessions mid-flight — hence requiresConsent + supportsDryRun.
 * Dry-run reports the exact command the helper would run.
 */

import { z } from "zod";

import { isDarwin, isWin32 } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "sync_system_time",
  description:
    "Forces an immediate NTP clock resync on the endpoint. Use ONLY after " +
    "check_ntp_status reports significant drift. Requires admin privileges, " +
    "supplied by the privileged helper daemon for non-admin users. Large " +
    "time jumps can break in-flight TLS sessions and trigger endpoint " +
    "security software alerts — always run dry-run first so the user can " +
    "see the command.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  schema: {
    server: z
      .string()
      .nullable().optional()
      .describe(
        "Reference NTP server. Defaults to 'time.apple.com' on macOS. " +
        "Ignored on Windows — W32Time reads from its configured peer.",
      ),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, report the command that would run without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface SyncTimeResult {
  platform: "darwin" | "win32" | "other";
  server:   string;
  command:  string;
  dryRun:   boolean;
  success:  boolean;
  message:  string;
}

// -- Default server -----------------------------------------------------------

const DEFAULT_SERVER = "time.apple.com";

// -- Dry-run preview (platform-aware, local) ---------------------------------

function plannedCommand(platform: "darwin" | "win32" | "other", server: string): string {
  if (platform === "darwin") return `sntp -sS ${shellQuote(server)}`;
  if (platform === "win32")  return "w32tm /resync /force";
  return "(unsupported)";
}

function previewDarwin(server: string): SyncTimeResult {
  const command = plannedCommand("darwin", server);
  return {
    platform: "darwin",
    server,
    command,
    dryRun:  true,
    success: true,
    message: `Would run \`${command}\` via the privileged helper. No changes yet.`,
  };
}

function previewWin32(server: string): SyncTimeResult {
  const command = plannedCommand("win32", server);
  return {
    platform: "win32",
    server,
    command,
    dryRun:  true,
    success: true,
    message: `Would run \`${command}\` via the privileged helper. No changes yet.`,
  };
}

function previewUnsupported(server: string): SyncTimeResult {
  return {
    platform: "other",
    server,
    command: "(unsupported)",
    dryRun:  true,
    success: false,
    message: "Unsupported platform — cannot sync system time.",
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Maps a raw error message to a user-friendly guidance message per
 * platform.  Used for the dry-run preview's manual-fallback hint when
 * the helper is unavailable — the user can run the underlying command
 * themselves with elevated privileges as a last resort.
 *
 * Exported for unit tests.
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

  const resolvedServer = server ?? DEFAULT_SERVER;

  if (dryRun) {
    // Dry-run: rendered locally so the consent card has something to
    // display.  This is side-effect free and returns the exact command
    // the helper would execute on confirmation.
    if (platform === "darwin") return previewDarwin(resolvedServer);
    if (platform === "win32")  return previewWin32(resolvedServer);
    return previewUnsupported(resolvedServer);
  }

  // Real-run: G4's scope-boundary check routes this op through the helper
  // daemon automatically because affectedScope: ["system"] + the helper
  // allowlist contains "sync_system_time".  The agent-side tool does NOT
  // shell out to `sudo sntp` / `w32tm` directly — that would bypass the
  // helper-routing pipeline, fail for non-admin users, and split the
  // audit trail between agent-local and helper-side logs.  Instead, we
  // throw a sentinel error here that the G4 layer intercepts and replaces
  // with the helper-routed call.
  //
  // When the agent runtime invokes this tool with dryRun=false, it does
  // so through the G4 executeStep, which has already chosen "route via
  // helper" for this tool.  The helper returns { server, command,
  // duration_ms }; the runtime maps that into the SyncTimeResult shape.
  throw new Error(
    "sync_system_time is helper-routed; the agent runtime should call the " +
    "helper bridge directly rather than this tool's local run().  " +
    "Reaching this code means the routing layer didn't intercept the call.",
  );
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
