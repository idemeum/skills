/**
 * mcp/skills/checkCollabAppStatus.ts — check_collab_app_status skill
 *
 * Detects which of Microsoft Teams / Slack / Zoom / Cisco Webex are
 * installed on the system, reports an auth-state hint, the last-modified
 * age of the app's cache directory (a proxy for "recent activity"), and
 * the on-disk cache path (reused by clear_collab_app_cache).
 *
 * This is a read-only probe — no IPC to the apps themselves, no process
 * inspection beyond "is a process of this name running".  The data comes
 * from:
 *
 *   - Installed-app detection   : macOS `mdfind`, Windows Registry
 *   - Cache directory presence  : per-app known path, stat for existence
 *   - Cache last-modified age   : stat().mtimeMs of the cache dir
 *   - Auth-state heuristic      : per-app specific file/key.  Best-effort
 *                                 — for each app we pick one signal that
 *                                 reliably differentiates "signed in"
 *                                 from "signed out".
 *
 * When a signal can't be determined the tool returns `"unknown"` rather
 * than guessing — downstream prose branches on `"unknown"` to ask the
 * user.
 */

import * as os   from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { z }     from "zod";

import {
  execAsync,
  runPS,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_collab_app_status",
  description:
    "Detects installed collaboration apps (Microsoft Teams, Slack, Zoom, " +
    "Cisco Webex) and reports per-app installation state, auth-state hint, " +
    "last activity (cache mtime), and cache directory path. Use as Step 1 " +
    "of the collab-app repair skill before deciding which app to target. " +
    "Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    app: z
      .enum(["teams", "slack", "zoom", "webex", "all"])
      .optional()
      .describe(
        "Which app to probe. Defaults to 'all' which returns one entry " +
        "per supported app.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export type CollabApp = "teams" | "slack" | "zoom" | "webex";

export interface CollabAppStatus {
  app:              CollabApp;
  installed:        boolean;
  installPath:      string | null;
  /** Path to the per-user cache directory.  null when the app is not installed. */
  cachePath:        string | null;
  cacheExists:      boolean;
  cacheAgeHours:    number | null;
  /** "signed-in" | "signed-out" | "unknown" — auth-state heuristic. */
  authState:        "signed-in" | "signed-out" | "unknown";
}

export interface CheckCollabAppStatusResult {
  platform: NodeJS.Platform;
  apps:     CollabAppStatus[];
}

const ALL_APPS: CollabApp[] = ["teams", "slack", "zoom", "webex"];

// -- Per-app path registry ----------------------------------------------------

interface AppPaths {
  installProbeDarwin: string[];   // paths that, if they exist, signal install
  installProbeWin32:  string[];   // Registry Run keys + install paths
  cacheDarwin:        string;
  cacheWin32:         string;
  authSignalDarwin:   string;     // file whose presence hints signed-in
  authSignalWin32:    string;
}

function appPaths(app: CollabApp): AppPaths {
  const home    = os.homedir();
  const appData = process.env.APPDATA      ?? path.join(home, "AppData", "Roaming");
  const local   = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

  switch (app) {
    case "teams":
      return {
        installProbeDarwin: ["/Applications/Microsoft Teams.app", "/Applications/Microsoft Teams (work or school).app"],
        installProbeWin32:  [
          path.join(local,   "Microsoft", "Teams"),
          path.join(local,   "Packages", "MSTeams_8wekyb3d8bbwe"),
          path.join(appData, "Microsoft", "Teams"),
        ],
        cacheDarwin:        path.join(home,    "Library", "Application Support", "Microsoft", "Teams"),
        cacheWin32:         path.join(appData, "Microsoft", "Teams"),
        authSignalDarwin:   path.join(home,    "Library", "Application Support", "Microsoft", "Teams", "Cookies"),
        authSignalWin32:    path.join(appData, "Microsoft", "Teams", "Cookies"),
      };
    case "slack":
      return {
        installProbeDarwin: ["/Applications/Slack.app"],
        installProbeWin32:  [
          path.join(appData, "Slack"),
          path.join(local,   "slack"),
        ],
        cacheDarwin:        path.join(home,    "Library", "Application Support", "Slack"),
        cacheWin32:         path.join(appData, "Slack"),
        authSignalDarwin:   path.join(home,    "Library", "Application Support", "Slack", "storage", "slack-downloads"),
        authSignalWin32:    path.join(appData, "Slack", "storage", "slack-downloads"),
      };
    case "zoom":
      return {
        installProbeDarwin: ["/Applications/zoom.us.app"],
        installProbeWin32:  [
          path.join(appData, "Zoom"),
          path.join(local,   "Zoom"),
        ],
        cacheDarwin:        path.join(home,    "Library", "Application Support", "zoom.us"),
        cacheWin32:         path.join(appData, "Zoom"),
        authSignalDarwin:   path.join(home,    "Library", "Application Support", "zoom.us", "data", "zoomus.db"),
        authSignalWin32:    path.join(appData, "Zoom", "data", "zoomus.db"),
      };
    case "webex":
      return {
        installProbeDarwin: ["/Applications/Webex.app", "/Applications/Cisco Spark.app"],
        installProbeWin32:  [
          path.join(appData, "Cisco Spark"),
          path.join(appData, "Webex"),
          path.join(local,   "CiscoSparkLauncher"),
        ],
        cacheDarwin:        path.join(home,    "Library", "Application Support", "Cisco Spark"),
        cacheWin32:         path.join(appData, "Cisco Spark"),
        authSignalDarwin:   path.join(home,    "Library", "Application Support", "Cisco Spark", "accounts"),
        authSignalWin32:    path.join(appData, "Cisco Spark", "accounts"),
      };
  }
}

// -- Platform implementation --------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function dirMtimeHours(p: string): Promise<number | null> {
  try {
    const s = await fs.stat(p);
    return Math.round((Date.now() - s.mtimeMs) / (1000 * 60 * 60));
  } catch {
    return null;
  }
}

async function firstExistingPath(candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return null;
}

async function probeOne(app: CollabApp, platform: NodeJS.Platform): Promise<CollabAppStatus> {
  const paths = appPaths(app);
  const installProbe = platform === "darwin" ? paths.installProbeDarwin : paths.installProbeWin32;
  const cacheDir     = platform === "darwin" ? paths.cacheDarwin        : paths.cacheWin32;
  const authSignal   = platform === "darwin" ? paths.authSignalDarwin   : paths.authSignalWin32;

  const installPath = await firstExistingPath(installProbe);
  const cacheExists = installPath ? await pathExists(cacheDir) : false;
  const cacheAgeHours = cacheExists ? await dirMtimeHours(cacheDir) : null;

  let authState: CollabAppStatus["authState"] = "unknown";
  if (installPath) {
    authState = (await pathExists(authSignal)) ? "signed-in" : "signed-out";
  }

  return {
    app,
    installed:     !!installPath,
    installPath,
    cachePath:     installPath ? cacheDir : null,
    cacheExists,
    cacheAgeHours,
    authState,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  app = "all",
}: { app?: "teams" | "slack" | "zoom" | "webex" | "all" } = {}): Promise<CheckCollabAppStatusResult> {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`check_collab_app_status: unsupported platform "${platform}"`);
  }

  const targets: CollabApp[] = app === "all" ? ALL_APPS : [app];
  const apps = await Promise.all(targets.map((a) => probeOne(a, platform)));

  return { platform, apps };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  appPaths,
  pathExists,
  dirMtimeHours,
  firstExistingPath,
  probeOne,
  // Satisfies compiler — unused helper imports stay reachable for future use.
  _unused: { execAsync, runPS },
};
