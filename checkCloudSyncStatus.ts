/**
 * mcp/skills/checkCloudSyncStatus.ts — check_cloud_sync_status skill
 *
 * Probes the on-disk state of cloud sync clients (OneDrive, iCloud Drive,
 * Google Drive, Dropbox) and reports per-tick a `stale` boolean +
 * supporting context that the proactive Trigger 4 (`cloud-sync-stale`)
 * evaluates on a steady schedule.
 *
 * Telemetry contract (Track B Phase 4)
 * ------------------------------------
 * `meta.outputKeys` includes: platform, client, lastSyncMs, queueDepth,
 * status, stale.  These are at the **top level** of the result so the
 * proactive evaluator's restricted DSL can reference them.  The DSL
 * never sees the per-client breakdown in `clients[]`.
 *
 * Default mode (`client: "auto"`) picks the most-stale installed
 * client, biased toward producing a `stale: true` observation when any
 * sync is overdue — that's what the rule wants to detect.  Caller can
 * pass `client: "onedrive"` etc. to inspect a specific client.
 *
 * Read-only — sync state mutation lives in `pause_resume_cloud_sync`.
 */

import * as os   from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { z }     from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_cloud_sync_status",
  description:
    "Reports the current sync state of installed cloud sync clients " +
    "(OneDrive, iCloud Drive, Google Drive, Dropbox) — per-client install " +
    "state, last-sync timestamp, queue depth where surfaced, and a top-level " +
    "`stale` flag set when any client's lastSync is older than the threshold " +
    "(default 24h). Used both by the user-facing Cloud Sync repair skill and " +
    "as the telemetry source for the proactive cloud-sync-stale trigger.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  outputKeys: [
    "platform",
    "client",
    "lastSyncMs",
    "queueDepth",
    "status",
    "stale",
  ],
  schema: {
    client: z
      .enum(["onedrive", "icloud", "google-drive", "dropbox", "auto"])
      .optional()
      .describe(
        "Which client's status to report at the top level. Default 'auto' " +
        "picks the most-stale installed client (the one that should fire " +
        "a proactive trigger if any do). Pass an explicit client to inspect " +
        "one specific sync.",
      ),
    staleThresholdHours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .optional()
      .describe("Hours since lastSync that count as stale. Default 24."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export type SyncClient = "onedrive" | "icloud" | "google-drive" | "dropbox";

export type SyncStatus =
  | "syncing"        // active sync in progress
  | "idle"           // fresh; nothing to do
  | "stale"          // hasn't synced in > threshold
  | "error"          // surfaced error from the client
  | "not-installed"
  | "unknown";

export interface SyncClientInfo {
  client:        SyncClient;
  installed:     boolean;
  /** Detected installation path (app bundle on darwin, directory on win32). */
  installPath:   string | null;
  /** ms since epoch — null when no probe path was readable. */
  lastSyncMs:    number | null;
  /** Number of items pending sync — null when not surfaced. */
  queueDepth:    number | null;
  status:        SyncStatus;
  stale:         boolean;
}

export interface CheckCloudSyncStatusResult {
  platform:    NodeJS.Platform;
  /** Top-level summary fields — duplicated from the chosen client (auto = most stale). */
  client:      SyncClient | null;
  lastSyncMs:  number | null;
  queueDepth:  number | null;
  status:      SyncStatus;
  stale:       boolean;
  /** Per-client breakdown for the skill's manual flow. */
  clients:     SyncClientInfo[];
}

const ALL_CLIENTS: SyncClient[] = ["onedrive", "icloud", "google-drive", "dropbox"];
const DEFAULT_STALE_HOURS = 24;

// -- Per-client probe paths ---------------------------------------------------

interface ProbePath {
  installPaths:    string[];   // existence of any one means "installed"
  syncProbePaths:  string[];   // mtime of newest existing path → lastSyncMs
}

function probePathsFor(client: SyncClient, platform: NodeJS.Platform): ProbePath {
  const home    = os.homedir();
  const appData = process.env.APPDATA      ?? path.join(home, "AppData", "Roaming");
  const local   = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

  switch (client) {
    case "onedrive":
      if (platform === "darwin") {
        return {
          installPaths:   ["/Applications/OneDrive.app"],
          syncProbePaths: [
            path.join(home, "Library", "Logs", "OneDrive"),
            path.join(home, "Library", "Application Support", "OneDrive"),
            path.join(home, "Library", "Containers", "com.microsoft.OneDrive-mac"),
          ],
        };
      }
      return {
        installPaths:   [
          path.join(local, "Microsoft", "OneDrive"),
          "C:\\Program Files\\Microsoft OneDrive",
          "C:\\Program Files (x86)\\Microsoft OneDrive",
        ],
        syncProbePaths: [
          path.join(local, "Microsoft", "OneDrive", "logs"),
          path.join(local, "Microsoft", "OneDrive", "settings"),
        ],
      };

    case "icloud":
      if (platform === "darwin") {
        return {
          installPaths:   [
            path.join(home, "Library", "Application Support", "CloudDocs"),
            path.join(home, "Library", "Mobile Documents"),
          ],
          syncProbePaths: [
            path.join(home, "Library", "Application Support", "CloudDocs", "session", "db"),
            path.join(home, "Library", "Mobile Documents"),
          ],
        };
      }
      // iCloud Drive on Windows is rare; the desktop client stores
      // state under %USERPROFILE%\iCloudDrive but the sync engine is
      // not deeply observable from outside the app.
      return {
        installPaths:   [
          path.join(local, "Apple Inc", "iCloud"),
          path.join(home, "iCloudDrive"),
        ],
        syncProbePaths: [
          path.join(home, "iCloudDrive"),
        ],
      };

    case "google-drive":
      if (platform === "darwin") {
        return {
          installPaths:   ["/Applications/Google Drive.app"],
          syncProbePaths: [
            path.join(home, "Library", "Application Support", "Google", "DriveFS", "Logs"),
            path.join(home, "Library", "Application Support", "Google", "DriveFS"),
          ],
        };
      }
      return {
        installPaths:   [
          path.join(local, "Google", "DriveFS"),
          "C:\\Program Files\\Google\\Drive File Stream",
        ],
        syncProbePaths: [
          path.join(local, "Google", "DriveFS", "Logs"),
          path.join(local, "Google", "DriveFS"),
        ],
      };

    case "dropbox":
      if (platform === "darwin") {
        return {
          installPaths:   [
            "/Applications/Dropbox.app",
            path.join(home, "Library", "Application Support", "Dropbox"),
          ],
          syncProbePaths: [
            path.join(home, "Library", "Application Support", "Dropbox", "instance1", "logs"),
            path.join(home, "Library", "Application Support", "Dropbox", "info.json"),
          ],
        };
      }
      return {
        installPaths:   [
          path.join(appData, "Dropbox"),
          path.join(local, "Dropbox"),
        ],
        syncProbePaths: [
          path.join(appData, "Dropbox", "info.json"),
          path.join(appData, "Dropbox", "instance1", "logs"),
        ],
      };
  }
}

// -- Filesystem helpers -------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function newestMtimeMs(paths: string[]): Promise<number | null> {
  let newest: number | null = null;
  for (const p of paths) {
    try {
      const s = await fs.stat(p);
      if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
      // Path missing — skip.
    }
  }
  return newest;
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

// -- Per-client status computation --------------------------------------------

function computeStatus(lastSyncMs: number | null, staleThresholdMs: number): { status: SyncStatus; stale: boolean } {
  if (lastSyncMs === null) return { status: "unknown", stale: false };
  const ageMs = Date.now() - lastSyncMs;
  if (ageMs >= staleThresholdMs) return { status: "stale", stale: true };
  // We don't have a clean "syncing-now" signal across all clients, so we
  // err on the side of "idle" when fresh.  A future revision could probe
  // an in-progress lock file per client.
  return { status: "idle", stale: false };
}

async function probeOne(
  client:           SyncClient,
  platform:         NodeJS.Platform,
  staleThresholdMs: number,
): Promise<SyncClientInfo> {
  const probe       = probePathsFor(client, platform);
  const installPath = await firstExistingPath(probe.installPaths);

  if (!installPath) {
    return {
      client,
      installed:    false,
      installPath:  null,
      lastSyncMs:   null,
      queueDepth:   null,
      status:       "not-installed",
      stale:        false,
    };
  }

  const lastSyncMs = await newestMtimeMs(probe.syncProbePaths);
  const { status, stale } = computeStatus(lastSyncMs, staleThresholdMs);

  return {
    client,
    installed:    true,
    installPath,
    lastSyncMs,
    queueDepth:   null,   // Per-client queue introspection is out of scope
                          // for the alpha — added later as each client's
                          // CLI / lock file is reverse-engineered.
    status,
    stale,
  };
}

// -- Top-level summary picker -------------------------------------------------

function pickTopLevel(
  clients: SyncClientInfo[],
  prefer:  SyncClient | "auto",
): SyncClientInfo | null {
  if (prefer !== "auto") return clients.find((c) => c.client === prefer) ?? null;

  // Prefer stale > installed > anything.  Among stale, the oldest sync
  // wins — that's the one most worth surfacing to the user.
  const installed = clients.filter((c) => c.installed);
  if (installed.length === 0) return null;

  const stale = installed.filter((c) => c.stale);
  if (stale.length > 0) {
    return stale.reduce((oldest, c) =>
      (c.lastSyncMs ?? Infinity) < (oldest.lastSyncMs ?? Infinity) ? c : oldest);
  }

  // No stale → return the newest sync (least likely to need attention,
  // but also the one the user is most likely to recognise as a working
  // baseline).
  return installed.reduce((newest, c) =>
    (c.lastSyncMs ?? 0) > (newest.lastSyncMs ?? 0) ? c : newest);
}

// -- Exported run function ----------------------------------------------------

export async function run({
  client = "auto",
  staleThresholdHours = DEFAULT_STALE_HOURS,
}: {
  client?:              "onedrive" | "icloud" | "google-drive" | "dropbox" | "auto";
  staleThresholdHours?: number;
} = {}): Promise<CheckCloudSyncStatusResult> {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`check_cloud_sync_status: unsupported platform "${platform}"`);
  }

  const staleThresholdMs = staleThresholdHours * 60 * 60 * 1000;
  const clients = await Promise.all(ALL_CLIENTS.map((c) => probeOne(c, platform, staleThresholdMs)));
  const top     = pickTopLevel(clients, client);

  return {
    platform,
    client:      top?.client     ?? null,
    lastSyncMs:  top?.lastSyncMs ?? null,
    queueDepth:  top?.queueDepth ?? null,
    status:      top?.status     ?? "not-installed",
    stale:       top?.stale      ?? false,
    clients,
  };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  ALL_CLIENTS,
  probePathsFor,
  pathExists,
  newestMtimeMs,
  firstExistingPath,
  computeStatus,
  probeOne,
  pickTopLevel,
};
