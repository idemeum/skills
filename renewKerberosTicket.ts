/**
 * mcp/skills/renewKerberosTicket.ts — renew_kerberos_ticket
 *
 * Renews or refreshes the user's Kerberos ticket-granting ticket (TGT)
 * after check_kerberos_ticket reports the ticket expired or expiring.
 *
 * Platform strategy
 * -----------------
 * darwin  `kinit -R` first (silent renewal of an existing TGT; preferred
 *         because no password prompt).  If that fails, we DO NOT fall
 *         back to `kinit <principal>` — that prompts for a password on
 *         stdin, which we refuse to handle in-agent.  Instead we return
 *         an "interactive" status and ask the user to run kinit
 *         themselves in their terminal.
 * win32   `klist purge` then `gpupdate /force` — purging the cache
 *         triggers Windows to re-acquire a TGT on the next operation
 *         that needs one, using the cached user credentials.
 *
 * Never handles passwords.  The destructive=false classification
 * reflects the fact that renewals are reversible (a new TGT can always
 * be acquired).  requiresConsent because repeated kinit failures can
 * lock a domain account.
 */

import { z } from "zod";

import { execAsync, isDarwin, isWin32 } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "renew_kerberos_ticket",
  description:
    "Renews the endpoint's Kerberos ticket-granting ticket (TGT) without " +
    "prompting for a password. On macOS uses `kinit -R`; on Windows uses " +
    "`klist purge` + `gpupdate /force`. Never accepts a password parameter " +
    "— if interactive authentication is required, returns a clear " +
    "'interactive' status and asks the user to run kinit in their terminal.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  // Only the Windows path needs admin (gpupdate /force). The macOS path
  // (kinit -R) runs as the user with no elevation needed, so darwin is
  // omitted here — escalation isn't applicable for that platform.
  escalationHint:  {
    win32: "gpupdate /force  # run from elevated Command Prompt; refreshes Group Policy and re-issues Kerberos tickets",
  },
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe("When true, report the command that would run without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface RenewResult {
  platform: "darwin" | "win32" | "other";
  command:  string;
  dryRun:   boolean;
  status:   "renewed" | "interactive" | "failed" | "unsupported";
  stdout?:  string;
  error?:   string;
  message:  string;
}

// -- Implementation -----------------------------------------------------------

async function renewDarwin(dryRun: boolean): Promise<RenewResult> {
  const command = `kinit -R`;
  if (dryRun) {
    return {
      platform: "darwin", command, dryRun: true, status: "renewed",
      message: `Would run \`${command}\` to renew the existing TGT.`,
    };
  }
  try {
    const { stdout } = await execAsync(command, {
      maxBuffer: 1 * 1024 * 1024, timeout: 10_000,
    });
    return {
      platform: "darwin", command, dryRun: false, status: "renewed",
      stdout,
      message: "Kerberos ticket renewed successfully.",
    };
  } catch (err) {
    const msg = (err as Error).message;
    // kinit -R fails with "cannot find a renewable ticket" when the
    // existing TGT has already expired or was never renewable — this is
    // a genuine case for interactive auth.  We surface it clearly and
    // refuse to prompt.
    const classification = classifyKinitError(msg);
    if (classification === "interactive") {
      return {
        platform: "darwin", command, dryRun: false, status: "interactive",
        error: msg,
        message:
          "Existing ticket is not renewable (missing or expired). " +
          "Open a terminal and run `kinit <your-principal>` to obtain a " +
          "fresh TGT — the agent will not handle your password.",
      };
    }
    return {
      platform: "darwin", command, dryRun: false, status: "failed",
      error: msg,
      message: `kinit -R failed: ${msg}`,
    };
  }
}

async function renewWin32(dryRun: boolean): Promise<RenewResult> {
  const command = `klist purge && gpupdate /force`;
  if (dryRun) {
    return {
      platform: "win32", command, dryRun: true, status: "renewed",
      message: `Would run \`klist purge\` then \`gpupdate /force\` to trigger TGT refresh.`,
    };
  }
  try {
    // Run the two commands sequentially so a failure in one is visible.
    const purge = await execAsync(`klist purge`, {
      maxBuffer: 1 * 1024 * 1024, timeout: 10_000,
    });
    const update = await execAsync(`gpupdate /force`, {
      maxBuffer: 1 * 1024 * 1024, timeout: 30_000,
    });
    return {
      platform: "win32", command, dryRun: false, status: "renewed",
      stdout: `${purge.stdout}\n${update.stdout}`,
      message: "Kerberos ticket cache purged and Group Policy refresh triggered.",
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      platform: "win32", command, dryRun: false, status: "failed",
      error: msg,
      message: `Kerberos refresh failed: ${msg}`,
    };
  }
}

/**
 * Classifies a raw kinit -R error message as "interactive" (no renewable
 * credential → user must run kinit manually) vs "failed" (any other
 * error).  Extracted so the branch logic can be unit-tested without
 * mocking rejected promises (vitest 4 flags those as unhandled
 * rejections even when caught).
 */
export function classifyKinitError(msg: string): "interactive" | "failed" {
  return /renewable|No credentials|cache|expired/i.test(msg) ? "interactive" : "failed";
}

// Exported for unit tests.
export const __testing = { renewDarwin, renewWin32 };

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = false,
}: {
  dryRun?: boolean;
} = {}): Promise<RenewResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  if (platform === "darwin") return renewDarwin(dryRun);
  if (platform === "win32")  return renewWin32(dryRun);

  return {
    platform: "other", command: "(unsupported)", dryRun, status: "unsupported",
    message: "Unsupported platform — Kerberos tools not available.",
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
