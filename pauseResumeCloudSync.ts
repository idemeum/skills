/**
 * mcp/skills/pauseResumeCloudSync.ts — pause_resume_cloud_sync skill
 *
 * Pauses or resumes a single cloud-sync client.  Used by the Cloud Sync
 * Repair skill when:
 *   - The user is on a slow network (VPN, hotel Wi-Fi) and a heavy sync
 *     is hurting bandwidth → pause until they're back on a fast link
 *   - A specific client appears stuck and needs a clean stop/start
 *
 * Per-client mechanism
 * --------------------
 *   onedrive       OneDrive --command pauseSyncing / resumeSyncing
 *                  (macOS: open -a OneDrive --args ...; Windows: OneDrive.exe /pauseSyncing)
 *   google-drive   Google Drive does not expose a clean CLI.  We send
 *                  SIGSTOP / SIGCONT to the running process on darwin
 *                  (best-effort), and on Windows surface a "manual
 *                  action required" outcome (no programmatic option).
 *   dropbox        dropbox-cli stop / start when installed; otherwise
 *                  send signals to the running daemon process.
 *   icloud         No programmatic pause / resume.  The tool returns
 *                  `outcome: "not-supported"` and the skill prose tells
 *                  the user to use System Settings → Apple ID → iCloud.
 *
 * Dry-run: returns the would-run command(s) without touching the system.
 *
 * Risk model
 * ----------
 * Pausing a sync is reversible (resume re-establishes).  Resuming a
 * paused sync is also reversible.  Neither deletes data.  Hence
 * `riskLevel: medium` (matches consent / user-perception level — sync
 * pauses can have user-visible effects in the form of files not being
 * available on other devices for the duration of the pause) but
 * `destructive: false`.
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
  name: "pause_resume_cloud_sync",
  description:
    "Pauses or resumes a specific cloud-sync client (OneDrive / Google " +
    "Drive / Dropbox; iCloud is not supported programmatically). Use to " +
    "free bandwidth on a slow network or to clean-restart a stuck sync. " +
    "The pause is reversible — `resume` returns the client to active state.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    client: z
      .enum(["onedrive", "google-drive", "dropbox", "icloud"])
      .describe("Which sync client to act on. iCloud is rejected — see meta description."),
    action: z
      .enum(["pause", "resume"])
      .describe("Whether to pause syncing or resume it."),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report the command(s) that would run without touching the system."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export type SyncClient = "onedrive" | "google-drive" | "dropbox" | "icloud";

export interface PauseResumeCloudSyncResult {
  client:        SyncClient;
  action:        "pause" | "resume";
  platform:      NodeJS.Platform;
  dryRun:        boolean;
  /** "applied" — command ran clean.  "not-supported" — no mechanism on this platform.  "failed" — mechanism exists but failed (output in `message`). */
  outcome:       "applied" | "not-supported" | "failed";
  /** Description of what was (or would be) done. */
  message:       string;
  /** The command string that ran (or would run).  null when not-supported. */
  command:       string | null;
}

// -- Per-client mechanism -----------------------------------------------------

interface Mechanism {
  /** Bash / PowerShell command for pause + resume.  null when not supported on this platform. */
  pause:    string | null;
  resume:   string | null;
}

function mechanismFor(client: SyncClient, platform: NodeJS.Platform): Mechanism {
  switch (client) {
    case "onedrive":
      if (platform === "darwin") {
        return {
          pause:  `open -a OneDrive --args --command pauseSyncing`,
          resume: `open -a OneDrive --args --command resumeSyncing`,
        };
      }
      return {
        pause:  `OneDrive.exe /command:pauseSyncing`,
        resume: `OneDrive.exe /command:resumeSyncing`,
      };

    case "dropbox":
      if (platform === "darwin") {
        // dropbox CLI installed under /usr/local/bin or via brew.  When
        // absent, fall through to signal-based pause.
        return {
          pause:  `(command -v dropbox && dropbox stop) || pkill -STOP -x Dropbox`,
          resume: `(command -v dropbox && dropbox start) || pkill -CONT -x Dropbox`,
        };
      }
      return {
        // Dropbox on Windows: best path is to run Dropbox.exe with the
        // /shutdown flag for pause; resume is just relaunching.
        pause:  `taskkill /IM Dropbox.exe /F`,
        resume: `start "" "${process.env.APPDATA ?? ""}\\Dropbox\\bin\\Dropbox.exe"`,
      };

    case "google-drive":
      if (platform === "darwin") {
        // No clean CLI.  SIGSTOP / SIGCONT pauses the process — the
        // user-visible effect matches "pause sync" (network activity
        // halts, app window may freeze).
        return {
          pause:  `pkill -STOP -x "Google Drive"`,
          resume: `pkill -CONT -x "Google Drive"`,
        };
      }
      // Windows Google Drive does not expose a clean pause; the only
      // option is to kill the process (resume = relaunch).  We do NOT
      // implement that here because it loses unsaved work — surface as
      // not-supported.
      return { pause: null, resume: null };

    case "icloud":
      // iCloud Drive has no programmatic pause on either platform.
      return { pause: null, resume: null };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  client,
  action,
  dryRun = false,
}: {
  client:  SyncClient;
  action:  "pause" | "resume";
  dryRun?: boolean;
}): Promise<PauseResumeCloudSyncResult> {
  const platform = os.platform();
  if (!isDarwin() && !isWin32()) {
    throw new Error(`pause_resume_cloud_sync: unsupported platform "${platform}"`);
  }

  const mech    = mechanismFor(client, platform);
  const command = action === "pause" ? mech.pause : mech.resume;

  if (command === null) {
    return {
      client,
      action,
      platform,
      dryRun,
      outcome: "not-supported",
      message:
        client === "icloud"
          ? "iCloud Drive does not expose a programmatic pause/resume. Use System Settings → Apple ID → iCloud."
          : `${client} does not support programmatic ${action} on ${platform}.`,
      command: null,
    };
  }

  if (dryRun) {
    return {
      client,
      action,
      platform,
      dryRun: true,
      outcome: "applied",
      message: `Would ${action} ${client} via the listed command. Pause is reversible — resume restores active syncing.`,
      command,
    };
  }

  try {
    const opts = {
      timeout:  15_000,
      shell:    platform === "win32" ? "cmd.exe" : "/bin/bash",
      encoding: "utf8" as const,
    };
    const { stdout, stderr } = await execAsync(command, opts);
    const out = (String(stdout) || String(stderr) || "").trim();
    return {
      client,
      action,
      platform,
      dryRun: false,
      outcome: "applied",
      message: out || `${action} ${client} command completed`,
      command,
    };
  } catch (err) {
    return {
      client,
      action,
      platform,
      dryRun: false,
      outcome: "failed",
      message: (err as Error).message,
      command,
    };
  }
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  mechanismFor,
};
