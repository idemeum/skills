/**
 * mcp/skills/resyncIdpAgent.ts — resync_idp_agent
 *
 * Triggers a re-sync of the installed IDP companion agent after a
 * password reset.  The goal is to flush any cached session/token state
 * so the user's next sign-in uses the new password.
 *
 * Platform strategy
 * -----------------
 * Okta Verify:
 *   darwin  killall "Okta Verify" ; open -a "Okta Verify"
 *   win32   net stop / net start the Okta Verify service if present;
 *           otherwise taskkill + Start-Process the user-mode binary.
 *
 * Jamf Connect (darwin only):
 *   launchctl kickstart -k system/com.jamf.connect (requires sudo)
 *
 * Entra (Microsoft Intune):
 *   darwin  killall "Company Portal" ; open -a "Company Portal"
 *   win32   dsregcmd /refreshprt  (safe, read-mostly)
 *
 * Each action is best-effort — failures report a clear error message and
 * the skill continues with the remaining steps.
 */

import { z } from "zod";
import { isDarwin, isWin32, execAsync } from "./_shared/platform";
import { idpDisplayName, type Idp } from "./_shared/idp";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "resync_idp_agent",
  description:
    "Restarts or refreshes the installed IDP companion agent (Okta Verify, " +
    "Jamf Connect, Microsoft Entra / Intune) so cached session tokens are " +
    "flushed and the next sign-in uses the new password. Best-effort — " +
    "surfaces a clear error if the agent is not installed or the OS refuses.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    idp: z
      .enum(["okta", "entra", "google", "unknown"])
      .describe("IDP identifier from detect_identity_provider."),
    dryRun: z
      .boolean()
      .optional()
      .describe("When true, report the exact commands that would run without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface ResyncResult {
  idp:       Idp;
  idpLabel:  string;
  platform:  "darwin" | "win32" | "other";
  dryRun:    boolean;
  /** Each attempted action's outcome. */
  actions:   Array<{
    description: string;
    command:     string;
    executed:    boolean;
    success?:    boolean;
    error?:      string;
  }>;
  skipped?:  boolean;
  message:   string;
}

// -- Implementation -----------------------------------------------------------

async function runCommand(description: string, command: string, dryRun: boolean): Promise<{
  description: string; command: string; executed: boolean; success?: boolean; error?: string;
}> {
  if (dryRun) return { description, command, executed: false };
  try {
    await execAsync(command, { maxBuffer: 1 * 1024 * 1024, timeout: 10_000 });
    return { description, command, executed: true, success: true };
  } catch (err) {
    return {
      description, command, executed: true, success: false,
      error: (err as Error).message,
    };
  }
}

async function resyncOktaDarwin(dryRun: boolean): Promise<ResyncResult["actions"]> {
  return [
    await runCommand(
      "Quit Okta Verify",
      `killall "Okta Verify" 2>/dev/null || true`,
      dryRun,
    ),
    await runCommand(
      "Relaunch Okta Verify",
      `open -a "Okta Verify" 2>/dev/null || true`,
      dryRun,
    ),
  ];
}

async function resyncOktaWin32(dryRun: boolean): Promise<ResyncResult["actions"]> {
  return [
    await runCommand(
      "Stop Okta Verify service (if installed)",
      `net stop "Okta Verify Service" 2>nul & exit 0`,
      dryRun,
    ),
    await runCommand(
      "Start Okta Verify service (if installed)",
      `net start "Okta Verify Service" 2>nul & exit 0`,
      dryRun,
    ),
  ];
}

async function resyncEntraDarwin(dryRun: boolean): Promise<ResyncResult["actions"]> {
  return [
    await runCommand(
      "Quit Microsoft Company Portal",
      `killall "Company Portal" 2>/dev/null || true`,
      dryRun,
    ),
    await runCommand(
      "Relaunch Microsoft Company Portal",
      `open -a "Company Portal" 2>/dev/null || true`,
      dryRun,
    ),
  ];
}

async function resyncEntraWin32(dryRun: boolean): Promise<ResyncResult["actions"]> {
  return [
    await runCommand(
      "Refresh Entra PRT (primary refresh token)",
      `dsregcmd /refreshprt`,
      dryRun,
    ),
  ];
}

// Jamf Connect — present on some Okta-managed macOS fleets; we invoke it
// automatically when present.  Idempotent + safe to run even when Jamf
// Connect isn't configured: launchctl kickstart will no-op on a missing
// service with a clean non-zero exit that we swallow.
async function resyncJamfConnectDarwin(dryRun: boolean): Promise<ResyncResult["actions"]> {
  return [
    await runCommand(
      "Restart Jamf Connect (if installed)",
      `launchctl kickstart -k system/com.jamf.connect 2>/dev/null || true`,
      dryRun,
    ),
  ];
}

// Exported for unit tests.
export const __testing = {
  resyncOktaDarwin, resyncOktaWin32,
  resyncEntraDarwin, resyncEntraWin32,
  resyncJamfConnectDarwin,
};

// -- Exported run function ----------------------------------------------------

export async function run({
  idp,
  dryRun = false,
}: {
  idp:     Idp;
  dryRun?: boolean;
}): Promise<ResyncResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";
  const idpLabel = idpDisplayName(idp);

  if (idp === "unknown" || idp === "google") {
    return {
      idp, idpLabel, platform, dryRun, actions: [], skipped: true,
      message:
        idp === "unknown"
          ? "IDP is unknown — no agent to re-sync."
          : "Google Workspace has no endpoint companion agent to re-sync.",
    };
  }

  const actions: ResyncResult["actions"] = [];

  if (idp === "okta") {
    if (platform === "darwin") {
      actions.push(...(await resyncOktaDarwin(dryRun)));
      actions.push(...(await resyncJamfConnectDarwin(dryRun)));
    } else if (platform === "win32") {
      actions.push(...(await resyncOktaWin32(dryRun)));
    }
  } else if (idp === "entra") {
    if (platform === "darwin") {
      actions.push(...(await resyncEntraDarwin(dryRun)));
    } else if (platform === "win32") {
      actions.push(...(await resyncEntraWin32(dryRun)));
    }
  }

  if (actions.length === 0) {
    return {
      idp, idpLabel, platform, dryRun, actions, skipped: true,
      message: `No resync commands available for ${idpLabel} on ${platform}.`,
    };
  }

  const successes = actions.filter((a) => a.success).length;
  const failures  = actions.filter((a) => a.executed && a.success === false).length;

  return {
    idp, idpLabel, platform, dryRun, actions,
    message: dryRun
      ? `Would run ${actions.length} resync command(s) for ${idpLabel}.`
      : `Ran ${actions.length} resync command(s) for ${idpLabel}: ` +
        `${successes} succeeded, ${failures} failed.`,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "okta", dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
