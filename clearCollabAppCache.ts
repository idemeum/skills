/**
 * mcp/skills/clearCollabAppCache.ts — clear_collab_app_cache skill
 *
 * Per-app cache clear for Microsoft Teams / Slack / Zoom / Cisco Webex.
 * The intent is to fix "stuck media", "search not finding messages",
 * "old meeting metadata" type problems WITHOUT signing the user out.
 *
 * Discipline
 * ----------
 *   - Cache directories cleared are an explicit per-app whitelist.  The
 *     tool refuses to take a wildcard or a user-supplied path — clearing
 *     is governed entirely by the app enum.
 *   - Auth artefacts are explicitly preserved: Cookies, Local Storage,
 *     IndexedDB, accounts.  These are NEVER on the clear list.
 *   - Dry-run path returns what WOULD be cleared (paths + total bytes)
 *     without touching disk.  G4 surfaces this to the user.
 *   - Errors per path are caught and reported in `errors[]` rather than
 *     aborting the whole operation — partial-clear is more useful than
 *     no-clear when one subdirectory has a stuck file lock (common
 *     while the app is running).
 */

import * as os   from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { z }     from "zod";

import type { CollabApp } from "./checkCollabAppStatus";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "clear_collab_app_cache",
  description:
    "Clears the per-user cache directories for one collab app (Teams, Slack, " +
    "Zoom, Webex), preserving authentication state (Cookies, Local Storage, " +
    "IndexedDB, accounts) so the user does NOT have to sign back in. Targets " +
    "media cache, search index, GPU cache, and meeting cache. Use when a " +
    "specific collab app is misbehaving (stuck media, stale search results, " +
    "old meeting cache) but the user is still signed in.",
  riskLevel:       "medium",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    app: z
      .enum(["teams", "slack", "zoom", "webex"])
      .describe("Which collab app's cache to clear. Wildcards rejected."),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report what would be cleared without deleting anything."),
  },
} as const;

// -- Per-app cache subdirectory whitelist -------------------------------------

interface AppCacheLayout {
  baseDarwin:       string;
  baseWin32:        string;
  /** Subdirectories under base that ARE safe to delete. */
  clearable:        string[];
  /** Subdirectories under base that MUST NOT be deleted (auth/identity). */
  preserved:        string[];
}

function appCacheLayout(app: CollabApp): AppCacheLayout {
  const home    = os.homedir();
  const appData = process.env.APPDATA      ?? path.join(home, "AppData", "Roaming");

  switch (app) {
    case "teams":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "Microsoft", "Teams"),
        baseWin32:  path.join(appData, "Microsoft", "Teams"),
        clearable:  [
          "Cache",
          "Code Cache",
          "GPUCache",
          "Service Worker/CacheStorage",
          "Service Worker/ScriptCache",
          "tmp",
        ],
        preserved:  ["Cookies", "Local Storage", "IndexedDB", "Session Storage"],
      };
    case "slack":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "Slack"),
        baseWin32:  path.join(appData, "Slack"),
        clearable:  [
          "Cache",
          "Code Cache",
          "GPUCache",
          "Service Worker/CacheStorage",
          "Service Worker/ScriptCache",
        ],
        preserved:  ["Cookies", "Local Storage", "IndexedDB", "storage"],
      };
    case "zoom":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "zoom.us"),
        baseWin32:  path.join(appData, "Zoom"),
        clearable:  [
          "data/Tcache",
          "data/Logs",
          "data/Avatar",
          "AutoUpdater/log",
        ],
        preserved:  ["data/zoomus.db", "data/zoommeeting", "Preferences"],
      };
    case "webex":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "Cisco Spark"),
        baseWin32:  path.join(appData, "Cisco Spark"),
        clearable:  [
          "Cache",
          "Code Cache",
          "GPUCache",
          "Service Worker/CacheStorage",
        ],
        preserved:  ["accounts", "databases", "Local Storage"],
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

async function dirSizeBytes(p: string): Promise<number> {
  try {
    const stack: string[] = [p];
    let total = 0;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries;
      try {
        entries = await fs.readdir(cur, { withFileTypes: true });
      } catch {
        continue;   // unreadable subdir — skip silently
      }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile()) {
          try {
            const s = await fs.stat(full);
            total += s.size;
          } catch {
            // unreadable file — skip
          }
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

// -- Types --------------------------------------------------------------------

export interface ClearedPathResult {
  path:        string;
  bytesFreed:  number;
}

export interface ClearCollabAppCacheResult {
  app:             CollabApp;
  platform:        NodeJS.Platform;
  dryRun:          boolean;
  basePath:        string;
  clearedPaths:    ClearedPathResult[];
  preservedPaths:  string[];
  sizeFreedBytes:  number;
  errors:          { path: string; message: string }[];
}

// -- Exported run function ----------------------------------------------------

export async function run({
  app,
  dryRun = false,
}: {
  app:     CollabApp;
  dryRun?: boolean;
}): Promise<ClearCollabAppCacheResult> {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`clear_collab_app_cache: unsupported platform "${platform}"`);
  }

  const layout   = appCacheLayout(app);
  const basePath = platform === "darwin" ? layout.baseDarwin : layout.baseWin32;

  if (!(await pathExists(basePath))) {
    return {
      app,
      platform,
      dryRun,
      basePath,
      clearedPaths:   [],
      preservedPaths: layout.preserved.map((p) => path.join(basePath, p)),
      sizeFreedBytes: 0,
      errors:         [{ path: basePath, message: `${app} is not installed (base path missing)` }],
    };
  }

  const clearedPaths:   ClearedPathResult[] = [];
  const errors:         { path: string; message: string }[] = [];
  let   sizeFreedBytes  = 0;

  for (const sub of layout.clearable) {
    const target = path.join(basePath, sub);
    if (!(await pathExists(target))) continue;

    const bytes = await dirSizeBytes(target);

    if (dryRun) {
      clearedPaths.push({ path: target, bytesFreed: bytes });
      sizeFreedBytes += bytes;
      continue;
    }

    try {
      await fs.rm(target, { recursive: true, force: true });
      clearedPaths.push({ path: target, bytesFreed: bytes });
      sizeFreedBytes += bytes;
    } catch (err) {
      errors.push({ path: target, message: (err as Error).message });
    }
  }

  return {
    app,
    platform,
    dryRun,
    basePath,
    clearedPaths,
    preservedPaths: layout.preserved.map((p) => path.join(basePath, p)),
    sizeFreedBytes,
    errors,
  };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  appCacheLayout,
  pathExists,
  dirSizeBytes,
};
