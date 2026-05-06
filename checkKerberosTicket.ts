/**
 * mcp/skills/checkKerberosTicket.ts — check_kerberos_ticket
 *
 * Lists active Kerberos tickets and flags ones that have expired or
 * will expire within the configured window.
 *
 * Platform strategy
 * -----------------
 * darwin  `klist` (Heimdal).  Output lists principal + valid-from/to.
 *         No tickets → non-zero exit; treat as a valid empty result.
 * win32   `klist` (built-in).  Output is ticket blocks prefixed with
 *         "#<idx>>".  We parse each block's Client, Server, EndTime.
 *
 * Never throws — parse failures resolve to { tickets: [], status: "error" }.
 */

import { z } from "zod";

import { execAsync, isDarwin, isWin32 } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_kerberos_ticket",
  description:
    "Lists active Kerberos tickets on the endpoint and flags any that are " +
    "expired or expiring soon. An expired or missing TGT is the top cause " +
    "of 'VPN says authentication failed' and similar AD-login issues. " +
    "Read-only; safe to run without consent.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    expiryWarnMinutes: z
      .number()
      .int()
      .min(1)
      .max(1440)
      .optional()
      .describe(
        "How many minutes before expiry to flag a ticket as 'expiring soon'. " +
        "Defaults to 60 (1 hour).",
      ),
  },
  // Top-level keys proactive-trigger DSL conditions may reference.
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  // `tickets` is an array; the DSL does not descend into arrays, so it
  // cannot be referenced directly from a condition. Rules that care about
  // ticket validity use `healthy` or `status` instead.
  outputKeys: ["platform", "tickets", "healthy", "status", "message"],
} as const;

// -- Types --------------------------------------------------------------------

export interface KerberosTicket {
  clientPrincipal: string;
  serverPrincipal: string;
  /** ISO 8601 timestamp; null if parsing failed. */
  endTime:         string | null;
  expired:         boolean;
  expiringSoon:    boolean;
}

export interface KerberosStatusResult {
  platform: "darwin" | "win32" | "other";
  tickets:  KerberosTicket[];
  /** True when at least one valid, non-expiring ticket is present. */
  healthy:  boolean;
  status:   "ok" | "expired" | "expiring" | "missing" | "error";
  message:  string;
}

// -- darwin parser ------------------------------------------------------------

function parseDarwinKlist(stdout: string, warnMs: number, now: number): KerberosTicket[] {
  // Heimdal klist sample:
  //   Credentials cache: FILE:/tmp/krb5cc_501
  //           Principal: alice@EXAMPLE.COM
  //     Issued                Expires              Principal
  //   Apr 21 10:00:00 2024  Apr 21 20:00:00 2024  krbtgt/EXAMPLE.COM@EXAMPLE.COM
  const tickets: KerberosTicket[] = [];
  const principalMatch = stdout.match(/Principal:\s*([^\n]+)/);
  const principal = principalMatch ? principalMatch[1].trim() : "(unknown)";

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(
      /^\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4}\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(\S+)/,
    );
    if (!m) continue;
    const endDate = new Date(m[1].replace(/\s+/g, " ") + " GMT+0000"); // best-effort; timezone may drift
    const serverPrincipal = m[2];
    const endMs = endDate.getTime();
    const valid = !isNaN(endMs);
    tickets.push({
      clientPrincipal: principal,
      serverPrincipal,
      endTime: valid ? endDate.toISOString() : null,
      expired: valid ? endMs < now : false,
      expiringSoon: valid ? endMs - now < warnMs && endMs > now : false,
    });
  }
  return tickets;
}

// -- win32 parser -------------------------------------------------------------

function parseWin32Klist(stdout: string, warnMs: number, now: number): KerberosTicket[] {
  // Windows klist sample:
  //   #0>    Client: alice @ EXAMPLE.COM
  //          Server: krbtgt/EXAMPLE.COM @ EXAMPLE.COM
  //          KerbTicket Encryption Type: ...
  //          Ticket Flags ...
  //          Start Time: 4/21/2024 10:00:00 (local)
  //          End Time:   4/21/2024 20:00:00 (local)
  const tickets: KerberosTicket[] = [];
  const blocks = stdout.split(/#\d+>/).slice(1);
  for (const block of blocks) {
    const clientMatch = block.match(/Client:\s*([^\n\r]+?)\s*$/m);
    const serverMatch = block.match(/Server:\s*([^\n\r]+?)\s*$/m);
    const endMatch    = block.match(/End Time:\s*([^\n\r]+?)\s*$/m);
    if (!clientMatch || !serverMatch) continue;
    const client = clientMatch[1].trim();
    const server = serverMatch[1].trim();
    let endIso: string | null = null;
    let endMs:  number | null = null;
    if (endMatch) {
      const raw = endMatch[1].replace(/\s*\((?:local|UTC)\)\s*$/i, "").trim();
      const d   = new Date(raw);
      if (!isNaN(d.getTime())) {
        endIso = d.toISOString();
        endMs  = d.getTime();
      }
    }
    tickets.push({
      clientPrincipal: client,
      serverPrincipal: server,
      endTime:        endIso,
      expired:        endMs !== null ? endMs < now : false,
      expiringSoon:   endMs !== null ? endMs - now < warnMs && endMs > now : false,
    });
  }
  return tickets;
}

/**
 * Classifies a raw klist error message as "missing" (no credential cache)
 * vs "error" (something else).  Extracted so the branch logic can be
 * unit-tested without mocking rejected promises (vitest 4 flags those
 * as unhandled rejections even inside try/catch).
 */
export function classifyKlistError(msg: string): "missing" | "error" {
  return /No credentials|cc_default|No such file/i.test(msg) ? "missing" : "error";
}

// Exported for unit tests.
export const __testing = { parseDarwinKlist, parseWin32Klist };

// -- Exported run function ----------------------------------------------------

export async function run({
  expiryWarnMinutes = 60,
}: {
  expiryWarnMinutes?: number;
} = {}): Promise<KerberosStatusResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  if (platform === "other") {
    return {
      platform, tickets: [], healthy: false,
      status: "error",
      message: "Unsupported platform — Kerberos tools not available.",
    };
  }

  const warnMs = expiryWarnMinutes * 60 * 1_000;
  const now    = Date.now();

  try {
    const { stdout } = await execAsync(`klist`, {
      maxBuffer: 2 * 1024 * 1024, timeout: 5_000,
    });
    const tickets = platform === "darwin"
      ? parseDarwinKlist(stdout, warnMs, now)
      : parseWin32Klist(stdout, warnMs, now);

    if (tickets.length === 0) {
      return {
        platform, tickets, healthy: false,
        status: "missing",
        message: "No Kerberos tickets present — user is not currently authenticated to a KDC.",
      };
    }

    const allExpired = tickets.every((t) => t.expired);
    const anyExpiring = tickets.some((t) => t.expiringSoon && !t.expired);
    const healthy = tickets.some((t) => !t.expired && !t.expiringSoon);

    const status: KerberosStatusResult["status"] =
      allExpired ? "expired" : anyExpiring ? "expiring" : healthy ? "ok" : "error";

    const message =
      status === "expired"
        ? `All ${tickets.length} Kerberos ticket(s) have expired. The user must re-authenticate.`
        : status === "expiring"
          ? `At least one Kerberos ticket expires within ${expiryWarnMinutes} minute(s).`
          : `Kerberos looks healthy — ${tickets.length} ticket(s) valid.`;

    return { platform, tickets, healthy, status, message };
  } catch (err) {
    // klist exits non-zero when no tickets exist on darwin.  Many Heimdal
    // distributions emit "klist: No credentials cache…" to stderr.
    const msg = (err as Error).message;
    const classification = classifyKlistError(msg);
    if (classification === "missing") {
      return {
        platform, tickets: [], healthy: false,
        status: "missing",
        message: "No Kerberos credentials cache found — user has no active tickets.",
      };
    }
    return {
      platform, tickets: [], healthy: false,
      status: "error",
      message: `klist failed: ${msg}`,
    };
  }
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
