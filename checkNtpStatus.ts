/**
 * mcp/skills/checkNtpStatus.ts — check_ntp_status
 *
 * Reports the endpoint's NTP configuration + offset from a reference
 * source.  An offset > ~5 min silently breaks Kerberos, SAML, and TOTP
 * simultaneously — this tool is how the identity-auth-repair skill
 * detects that root cause.
 *
 * Platform strategy
 * -----------------
 * darwin  `sntp -d <server>` — unauthenticated NTP query (no admin).
 *         Parses "offset <seconds>" from the debug output.
 * win32   `w32tm /query /status` — reports Source, Phase Offset,
 *         Last Successful Sync Time.  Also surfaces the service state
 *         so we can flag disabled W32Time on workgroup machines.
 *
 * Returns an offset in milliseconds (positive = endpoint is ahead of
 * reference; negative = behind).  Never throws — network / exec
 * failures resolve to { offsetMs: null, status: "error", … }.
 */

import { z } from "zod";

import { execAsync, isDarwin, isWin32 } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_ntp_status",
  description:
    "Reports the endpoint's NTP synchronisation status and current offset " +
    "from a reference time source, in milliseconds. An offset > ~300000 ms " +
    "(5 minutes) breaks Kerberos, SAML, and TOTP simultaneously — this tool " +
    "is the first diagnostic step when users report 'all SSO apps are " +
    "broken.' Read-only; safe to run without consent.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    server: z
      .string()
      .optional()
      .describe(
        "Reference NTP server. Defaults to 'time.apple.com' on macOS and " +
        "'time.windows.com' on Windows.",
      ),
  },
  // Top-level keys proactive-trigger DSL conditions may reference.
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  outputKeys: [
    "platform",
    "server",
    "offsetMs",
    "absOffsetMs",
    "lastSync",
    "serviceState",
    "status",
    "message",
  ],
} as const;

// -- Types --------------------------------------------------------------------

export interface NtpStatusResult {
  platform:    "darwin" | "win32" | "other";
  server:      string;
  /** Offset in milliseconds (positive = endpoint ahead, negative = behind). */
  offsetMs:    number | null;
  /** Absolute value of offsetMs; convenient for threshold checks. */
  absOffsetMs: number | null;
  /** Human-readable last successful sync time (null on darwin fallback or unknown). */
  lastSync:    string | null;
  /** W32Time / timed service state ("running" / "stopped" / "unknown"). */
  serviceState: "running" | "stopped" | "unknown";
  status:      "ok" | "drifted" | "error";
  message:     string;
}

const DRIFT_THRESHOLD_MS = 5 * 60 * 1_000; // 5 min — standard Kerberos tolerance

// -- darwin implementation ----------------------------------------------------

async function checkDarwin(server: string): Promise<NtpStatusResult> {
  // `sntp -d` emits lines like:
  //   sntp: 2024-04-21 23:10:01 -0.123456 +/- 0.045 time.apple.com
  // and also a "leap 0, ..." line. We grep for the signed float after the date.
  try {
    const { stdout } = await execAsync(
      `sntp -d ${shellQuote(server)} 2>&1`,
      { maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
    );
    const match = stdout.match(/[-+]\d+(?:\.\d+)?\s+\+\/-/);
    if (!match) {
      return {
        platform: "darwin", server,
        offsetMs: null, absOffsetMs: null,
        lastSync: null, serviceState: "unknown",
        status: "error",
        message: `sntp returned no parseable offset: ${stdout.slice(0, 200)}`,
      };
    }
    const offsetSeconds = parseFloat(match[0].replace(/\s+\+\/-$/, "").trim());
    const offsetMs = Math.round(offsetSeconds * 1_000);
    const absMs    = Math.abs(offsetMs);
    const drifted  = absMs > DRIFT_THRESHOLD_MS;
    return {
      platform: "darwin", server,
      offsetMs, absOffsetMs: absMs,
      lastSync:     null, // sntp one-shot doesn't report last-sync from the daemon
      serviceState: "unknown",
      status:       drifted ? "drifted" : "ok",
      message: drifted
        ? `Endpoint clock is ${Math.round(absMs / 1000)}s ${offsetMs > 0 ? "ahead of" : "behind"} ${server} — Kerberos/SAML/TOTP will fail.`
        : `Endpoint clock is within ${Math.round(absMs)}ms of ${server}.`,
    };
  } catch (err) {
    return {
      platform: "darwin", server,
      offsetMs: null, absOffsetMs: null,
      lastSync: null, serviceState: "unknown",
      status: "error",
      message: `sntp failed: ${(err as Error).message}`,
    };
  }
}

// -- win32 implementation -----------------------------------------------------

async function checkWin32(server: string): Promise<NtpStatusResult> {
  // Service probe first — a stopped W32Time service is the top cause of
  // inaccurate Windows clocks.  `sc query w32time` reports STATE: 4 RUNNING.
  let serviceState: "running" | "stopped" | "unknown" = "unknown";
  try {
    const { stdout } = await execAsync(`sc query w32time`, {
      maxBuffer: 1 * 1024 * 1024, timeout: 5_000,
    });
    if (/STATE\s*:\s*4\s*RUNNING/i.test(stdout))   serviceState = "running";
    else if (/STATE\s*:\s*1\s*STOPPED/i.test(stdout)) serviceState = "stopped";
  } catch {
    // Service query failed — leave serviceState as "unknown".
  }

  try {
    const { stdout } = await execAsync(`w32tm /query /status`, {
      maxBuffer: 1 * 1024 * 1024, timeout: 5_000,
    });
    // Phase Offset: 0.0012345s  (English locale)
    const offMatch = stdout.match(/Phase Offset\s*:\s*([-+]?\d+(?:\.\d+)?)s/i);
    const lastMatch = stdout.match(/Last Successful Sync Time\s*:\s*(.+)/i);
    if (!offMatch) {
      return {
        platform: "win32", server,
        offsetMs: null, absOffsetMs: null,
        lastSync: lastMatch ? lastMatch[1].trim() : null,
        serviceState,
        status: "error",
        message: `w32tm returned no parseable Phase Offset.`,
      };
    }
    const offsetMs = Math.round(parseFloat(offMatch[1]) * 1_000);
    const absMs    = Math.abs(offsetMs);
    const drifted  = absMs > DRIFT_THRESHOLD_MS;
    return {
      platform: "win32", server,
      offsetMs, absOffsetMs: absMs,
      lastSync: lastMatch ? lastMatch[1].trim() : null,
      serviceState,
      status:   drifted ? "drifted" : "ok",
      message: drifted
        ? `Endpoint clock is ${Math.round(absMs / 1000)}s ${offsetMs > 0 ? "ahead of" : "behind"} reference — Kerberos/SAML/TOTP will fail.`
        : `Endpoint clock is within ${absMs}ms of reference (last sync: ${lastMatch ? lastMatch[1].trim() : "unknown"}).`,
    };
  } catch (err) {
    return {
      platform: "win32", server,
      offsetMs: null, absOffsetMs: null,
      lastSync:     null,
      serviceState,
      status: "error",
      message: `w32tm /query /status failed: ${(err as Error).message}`,
    };
  }
}

// -- Helpers ------------------------------------------------------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Exported for unit tests.
export const __testing = { checkDarwin, checkWin32, DRIFT_THRESHOLD_MS };

// -- Exported run function ----------------------------------------------------

export async function run({
  server,
}: {
  server?: string;
} = {}): Promise<NtpStatusResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  const defaultServer = platform === "win32" ? "time.windows.com" : "time.apple.com";
  const resolvedServer = server ?? defaultServer;

  if (platform === "darwin") return checkDarwin(resolvedServer);
  if (platform === "win32")  return checkWin32(resolvedServer);

  return {
    platform: "other", server: resolvedServer,
    offsetMs: null, absOffsetMs: null,
    lastSync: null, serviceState: "unknown",
    status: "error",
    message: "Unsupported platform — cannot check NTP status.",
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
