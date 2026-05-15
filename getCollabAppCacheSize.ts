/**
 * mcp/skills/getCollabAppCacheSize.ts — get_collab_app_cache_size
 *
 * Reports per-app cache directory sizes for Microsoft Teams / Slack /
 * Zoom / Cisco Webex without modifying anything.  Read-only counterpart
 * to `clear_collab_app_cache`.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getCollabAppCacheSize.ts
 *
 * NOTE: cache directory layout is duplicated from `clearCollabAppCache.ts`
 * — keep in sync if per-app cache subdirectory lists change.
 */

import * as os   from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { z }     from "zod";

import type { CollabApp } from "./checkCollabAppStatus";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_collab_app_cache_size",
  description:
    "Reports per-app clearable-cache directory sizes for Teams / Slack / " +
    "Zoom / Webex without modifying anything. Read-only counterpart to " +
    "clear_collab_app_cache.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    apps: z
      .array(z.enum(["teams", "slack", "zoom", "webex"]))
      .optional()
      .describe(
        "Which collab apps to probe. Omit to scan all four. Wildcards rejected.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface CollabAppCacheInfo {
  app:         CollabApp;
  installed:   boolean;
  basePath:    string;
  sizeBytes:   number;
  perPath:     Array<{ path: string; sizeBytes: number }>;
}

export interface GetCollabAppCacheSizeResult {
  platform:   NodeJS.Platform;
  apps:       CollabAppCacheInfo[];
  totalBytes: number;
  errors?:    Array<{ scope: string; message: string }>;
}

// -- Helpers ------------------------------------------------------------------

interface AppCacheLayout { baseDarwin: string; baseWin32: string; clearable: string[] }

function appCacheLayout(app: CollabApp): AppCacheLayout {
  const home    = os.homedir();
  const appData = process.env["APPDATA"] ?? path.join(home, "AppData", "Roaming");

  switch (app) {
    case "teams":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "Microsoft", "Teams"),
        baseWin32:  path.join(appData, "Microsoft", "Teams"),
        clearable:  ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache", "tmp"],
      };
    case "slack":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "Slack"),
        baseWin32:  path.join(appData, "Slack"),
        clearable:  ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache"],
      };
    case "zoom":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "zoom.us"),
        baseWin32:  path.join(appData, "Zoom"),
        clearable:  ["data/Tcache", "data/Logs", "data/Avatar", "AutoUpdater/log"],
      };
    case "webex":
      return {
        baseDarwin: path.join(home,    "Library", "Application Support", "Cisco Spark"),
        baseWin32:  path.join(appData, "Cisco Spark"),
        clearable:  ["Cache", "Code Cache", "GPUCache", "Service Worker/CacheStorage"],
      };
  }
}

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
      } catch { continue; }
      for (const e of entries) {
        const full = path.join(cur, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile()) {
          try {
            const s = await fs.stat(full);
            total += s.size;
          } catch { /* skip */ }
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function probeApp(app: CollabApp, platform: NodeJS.Platform): Promise<CollabAppCacheInfo> {
  const layout   = appCacheLayout(app);
  const basePath = platform === "darwin" ? layout.baseDarwin : layout.baseWin32;
  if (!(await pathExists(basePath))) {
    return { app, installed: false, basePath, sizeBytes: 0, perPath: [] };
  }
  const perPath: CollabAppCacheInfo["perPath"] = [];
  let sizeBytes = 0;
  for (const sub of layout.clearable) {
    const target = path.join(basePath, sub);
    if (!(await pathExists(target))) continue;
    const bytes = await dirSizeBytes(target);
    perPath.push({ path: target, sizeBytes: bytes });
    sizeBytes += bytes;
  }
  return { app, installed: true, basePath, sizeBytes, perPath };
}

// -- Exported run -------------------------------------------------------------

const DEFAULT_APPS: CollabApp[] = ["teams", "slack", "zoom", "webex"];

export async function run({
  apps,
}: { apps?: CollabApp[] } = {}): Promise<GetCollabAppCacheSizeResult> {
  const platform = os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    return {
      platform,
      apps: [],
      totalBytes: 0,
      errors: [{ scope: "platform", message: `unsupported platform: ${platform}` }],
    };
  }

  const selected = apps && apps.length > 0 ? apps : DEFAULT_APPS;
  const results  = await Promise.all(selected.map((a) => probeApp(a, platform)));
  results.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = results.reduce((s, a) => s + a.sizeBytes, 0);

  return { platform, apps: results, totalBytes };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
