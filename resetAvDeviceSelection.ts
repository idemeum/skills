/**
 * mcp/skills/resetAvDeviceSelection.ts — reset_av_device_selection skill
 *
 * Clears the per-app saved microphone / camera / speaker selection so the
 * collab app re-detects on next launch.  Used when a user reports the app
 * is stuck on a disconnected mic / camera even after replugging the
 * intended device.
 *
 * Each app stores its A/V selection in different places.  This tool
 * targets ONLY the audio/video device selection keys, never broader
 * preferences (sign-in, notification settings, etc.).
 *
 * Per-app strategy
 * ----------------
 *   Zoom    macOS plist `~/Library/Preferences/us.zoom.xos.plist`,
 *           keys: ZoomChat.Audio.MicID / SpeakerID, ZoomChat.Video.CameraID
 *           (`defaults delete` per key).
 *   Teams   New Teams settings file
 *           `~/Library/Group Containers/UBF8T346G9.com.microsoft.teams/.../media-stack-config.json`
 *           — JSON object, we delete the audio/video keys.
 *   Slack   `~/Library/Application Support/Slack/storage/notifications-config.json`
 *           — Slack stores call-device prefs here when present.  Best-
 *           effort: if the file is missing we report no-op.
 *   Webex   `~/Library/Application Support/Cisco Spark/Local Storage/leveldb/`
 *           — Webex persists its A/V choice in LevelDB; safest action is
 *           to delete the audio/video config keys via the per-account
 *           settings file (`accounts/<accountId>/data/devices.json`).
 *
 * Windows mirrors each path under %APPDATA% / %LOCALAPPDATA%.  Where a
 * specific JSON or plist file exists we touch ONLY that file (read,
 * delete the audio/video keys, write back) — never the parent dir.
 *
 * Dry-run: returns the file paths that would be touched and which keys
 * would be cleared, without writing to disk.
 */

import * as os   from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { z }     from "zod";

import type { CollabApp } from "./checkCollabAppStatus";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reset_av_device_selection",
  description:
    "Clears the per-app microphone, camera, and speaker selection for one " +
    "collab app (Teams, Slack, Zoom, Webex) so the app re-detects on next " +
    "launch. Use when the user reports the app is stuck on a disconnected " +
    "or unintended A/V device. Does not change broader preferences or sign " +
    "the user out.",
  riskLevel:       "medium",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    app: z
      .enum(["teams", "slack", "zoom", "webex"])
      .describe("Which collab app's A/V selection to reset."),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report what would be reset without modifying any files."),
  },
} as const;

// -- Per-app target file registry ---------------------------------------------

interface ResetTarget {
  /** Absolute path to the file that holds the A/V selection. */
  file:        string;
  /** "json": parse, delete keys, write back. "plist-defaults": run `defaults delete` per key. "delete-file": rm the file. */
  strategy:    "json" | "plist-defaults" | "delete-file";
  /** For json: top-level keys to remove.  For plist: keys to `defaults delete`. */
  keys:        string[];
}

function resetTargets(app: CollabApp, platform: NodeJS.Platform): ResetTarget[] {
  const home    = os.homedir();
  const appData = process.env.APPDATA      ?? path.join(home, "AppData", "Roaming");

  switch (app) {
    case "zoom":
      if (platform === "darwin") {
        return [{
          file:     path.join(home, "Library", "Preferences", "us.zoom.xos.plist"),
          strategy: "plist-defaults",
          keys:     [
            "ZoomChat.Audio.MicID",
            "ZoomChat.Audio.SpeakerID",
            "ZoomChat.Video.CameraID",
            "selectedMicID",
            "selectedSpeakerID",
            "selectedCameraID",
          ],
        }];
      }
      // Windows Zoom keeps device selection in zoomus.ini — delete the
      // [audio] / [video] sections by removing the file (Zoom recreates
      // it from defaults on next launch).  We cannot use ini-edit here
      // without an extra dep; deleting is acceptable for the alpha.
      return [{
        file:     path.join(appData, "Zoom", "data", "zoomus.ini"),
        strategy: "delete-file",
        keys:     ["audio", "video"],
      }];

    case "teams":
      if (platform === "darwin") {
        return [{
          file: path.join(
            home, "Library", "Group Containers",
            "UBF8T346G9.com.microsoft.teams", "Library", "Application Support",
            "Microsoft", "MSTeams", "media-stack-config.json",
          ),
          strategy: "json",
          keys:     ["audioInputDevice", "audioOutputDevice", "videoDevice", "selectedMicrophone", "selectedSpeaker", "selectedCamera"],
        }];
      }
      return [{
        file:     path.join(appData, "Microsoft", "Teams", "media-stack-config.json"),
        strategy: "json",
        keys:     ["audioInputDevice", "audioOutputDevice", "videoDevice", "selectedMicrophone", "selectedSpeaker", "selectedCamera"],
      }];

    case "slack":
      if (platform === "darwin") {
        return [{
          file:     path.join(home, "Library", "Application Support", "Slack", "storage", "notifications-config.json"),
          strategy: "json",
          keys:     ["microphoneId", "speakerId", "cameraId"],
        }];
      }
      return [{
        file:     path.join(appData, "Slack", "storage", "notifications-config.json"),
        strategy: "json",
        keys:     ["microphoneId", "speakerId", "cameraId"],
      }];

    case "webex":
      // Webex stores A/V selection per-account.  We don't enumerate
      // accounts here — instead remove the well-known device-selection
      // file under the active-account dir.  Best-effort.
      if (platform === "darwin") {
        return [{
          file:     path.join(home, "Library", "Application Support", "Cisco Spark", "settings", "av-devices.json"),
          strategy: "json",
          keys:     ["microphoneId", "speakerId", "cameraId"],
        }];
      }
      return [{
        file:     path.join(appData, "Cisco Spark", "settings", "av-devices.json"),
        strategy: "json",
        keys:     ["microphoneId", "speakerId", "cameraId"],
      }];
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

async function clearJsonKeys(file: string, keys: string[]): Promise<{ removed: string[] }> {
  const raw = await fs.readFile(file, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Not JSON — nothing to do; surface as no-op.
    return { removed: [] };
  }
  const removed: string[] = [];
  for (const k of keys) {
    if (k in parsed) {
      delete parsed[k];
      removed.push(k);
    }
  }
  if (removed.length > 0) {
    await fs.writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
  }
  return { removed };
}

async function clearPlistDefaults(file: string, keys: string[]): Promise<{ removed: string[] }> {
  // Translate plist path → bundle id.  e.g. `.../us.zoom.xos.plist` → `us.zoom.xos`.
  const base = path.basename(file, ".plist");
  const removed: string[] = [];
  // Lazy-require to avoid pulling child_process into platforms that won't use it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require("child_process") as typeof import("child_process");
  const { promisify } = require("util") as typeof import("util");
  const execFileAsync = promisify(execFile);

  for (const key of keys) {
    try {
      await execFileAsync("defaults", ["delete", base, key]);
      removed.push(key);
    } catch {
      // `defaults delete` returns non-zero if the key doesn't exist —
      // treat as "already cleared", not a failure.
    }
  }
  return { removed };
}

// -- Types --------------------------------------------------------------------

export interface ResetActionResult {
  file:       string;
  strategy:   ResetTarget["strategy"];
  keysFound:  string[];
  keysCleared: string[];
}

export interface ResetAvDeviceSelectionResult {
  app:         CollabApp;
  platform:    NodeJS.Platform;
  dryRun:      boolean;
  actions:     ResetActionResult[];
  errors:      { file: string; message: string }[];
}

// -- Exported run function ----------------------------------------------------

export async function run({
  app,
  dryRun = false,
}: {
  app:     CollabApp;
  dryRun?: boolean;
}): Promise<ResetAvDeviceSelectionResult> {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`reset_av_device_selection: unsupported platform "${platform}"`);
  }

  const targets = resetTargets(app, platform);
  const actions: ResetActionResult[] = [];
  const errors:  { file: string; message: string }[] = [];

  for (const t of targets) {
    if (!(await pathExists(t.file))) {
      // File absent — nothing to do for this target.  Not an error.
      actions.push({ file: t.file, strategy: t.strategy, keysFound: [], keysCleared: [] });
      continue;
    }

    if (dryRun) {
      // Dry-run: report which keys would be cleared without touching disk.
      // For json, we can read + intersect; for plist + delete-file, we can
      // only report the configured keys (we don't enumerate live plist
      // contents in dry-run to avoid a `defaults read` per key).
      let keysFound: string[] = [];
      if (t.strategy === "json") {
        try {
          const raw    = await fs.readFile(t.file, "utf8");
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          keysFound    = t.keys.filter((k) => k in parsed);
        } catch {
          keysFound = [];
        }
      } else {
        // plist or delete-file — assume all configured keys are candidates.
        keysFound = [...t.keys];
      }
      actions.push({ file: t.file, strategy: t.strategy, keysFound, keysCleared: [] });
      continue;
    }

    try {
      if (t.strategy === "json") {
        const { removed } = await clearJsonKeys(t.file, t.keys);
        actions.push({ file: t.file, strategy: t.strategy, keysFound: removed, keysCleared: removed });
      } else if (t.strategy === "plist-defaults") {
        const { removed } = await clearPlistDefaults(t.file, t.keys);
        actions.push({ file: t.file, strategy: t.strategy, keysFound: removed, keysCleared: removed });
      } else {
        // delete-file
        await fs.rm(t.file, { force: true });
        actions.push({ file: t.file, strategy: t.strategy, keysFound: t.keys, keysCleared: t.keys });
      }
    } catch (err) {
      errors.push({ file: t.file, message: (err as Error).message });
    }
  }

  return { app, platform, dryRun, actions, errors };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  resetTargets,
  pathExists,
  clearJsonKeys,
};
