/**
 * mcp/skills/clearAppCache.ts — clear_app_cache skill
 *
 * Clears application cache files from the system cache directory. Can target
 * a specific app or list all caches. Defaults to dryRun=true for safety.
 *
 * Platform strategy
 * -----------------
 * darwin  Scans ~/Library/Caches — subdirectories per application
 * win32   Scans %LOCALAPPDATA% and %TEMP% for app cache folders
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/clearAppCache.ts [appName]
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { z }         from "zod";

import {
  DARWIN_BROWSER_CACHE_DIR_NAMES,
  WIN32_BROWSER_VENDOR_DIR_NAMES,
  isWin32BrowserVendorDir,
} from "./_shared/browserCaches";
import { DEV_CACHE_DIR_NAMES, isDevCacheDir } from "./_shared/devCaches";
import { getDirSizeBytes } from "./_shared/dirSize";
import type { Footprint } from "./_shared/footprint";

// -- Meta ---------------------------------------------------------------------

// Footprint excludes are derived from the SAME ownership sets the runtime
// filter uses, so the declared footprint can never drift from actual behavior.
const APP_CACHE_FOOTPRINT: Footprint = {
  kind: "sweep",
  darwin: {
    roots: ["~/Library/Caches"],
    excludes: [
      ...[...DARWIN_BROWSER_CACHE_DIR_NAMES].map((n) => `~/Library/Caches/${n}`),
      ...[...DEV_CACHE_DIR_NAMES].map((n) => `~/Library/Caches/${n}`),
    ],
  },
  win32: {
    roots: ["%LOCALAPPDATA%", "%TEMP%"],
    excludes: [
      ...[...WIN32_BROWSER_VENDOR_DIR_NAMES].map((n) => `%LOCALAPPDATA%/${n}`),
      ...[...DEV_CACHE_DIR_NAMES].map((n) => `%LOCALAPPDATA%/${n}`),
    ],
  },
};

export const meta = {
  name: "clear_app_cache",
  description:
    "Clears application cache files from the system cache directory. " +
    "Can target a specific app or clear all caches. " +
    "Use to free disk space or resolve app performance issues caused by corrupt cache.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  footprint:       APP_CACHE_FOOTPRINT,
  schema: {
    appName: z
      .string()
      .optional()
      .describe("App name to target (e.g. 'Slack', 'Chrome'). Omit + dryRun:false to clear every app cache (used by the disk-cleanup present_preview flow)."),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report what would be deleted without deleting. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface CacheEntry {
  name:   string;
  path:   string;
  sizeMb: number;
}

// -- Helpers ------------------------------------------------------------------

async function getDirSizeMb(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { recursive: true, withFileTypes: true });
    let totalBytes = 0;
    await Promise.all(
      entries
        .filter((e) => !e.isDirectory())
        .map(async (e) => {
          try {
            const fullPath = nodePath.join(e.parentPath ?? (e as unknown as { path: string }).path ?? dirPath, e.name);
            const stat = await fs.stat(fullPath);
            totalBytes += stat.size;
          } catch {
            // skip inaccessible files
          }
        }),
    );
    // SI/decimal MB to match _shared/formatBytes.ts + Finder.
    return Math.round((totalBytes / 1_000_000) * 100) / 100;
  } catch {
    return 0;
  }
}

/** Prevent path traversal — ensure path stays within allowedRoot. */
function isSafePath(target: string, allowedRoot: string): boolean {
  const rel = nodePath.relative(allowedRoot, target);
  return !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

// -- darwin implementation ----------------------------------------------------

async function clearAppCacheDarwin(
  appName: string | undefined,
  dryRun:  boolean,
): Promise<{ caches: CacheEntry[]; totalSizeMb: number; deleted: boolean; freedMb: number }> {
  const cacheRoot = nodePath.join(os.homedir(), "Library", "Caches");

  let dirents: import("fs").Dirent[];
  try {
    dirents = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return { caches: [], totalSizeMb: 0, deleted: false, freedMb: 0 };
  }

  const subdirs = dirents.filter((d) => d.isDirectory());

  // If appName provided, filter to matching subdirs (case-insensitive).
  // In the bulk (no appName) disk-cleanup flow, exclude browser + dev cache
  // dirs — those categories own them; clearing them here deletes Chrome / pip /
  // Yarn before clear_browser_cache / clear_dev_cache run (and clears dev caches
  // even when only "App caches" was selected). An explicit appName target still
  // wins. See _shared/browserCaches.ts and _shared/devCaches.ts.
  const matched = appName
    ? subdirs.filter((d) => d.name.toLowerCase().includes(appName.toLowerCase()))
    : subdirs.filter((d) => !DARWIN_BROWSER_CACHE_DIR_NAMES.has(d.name) && !isDevCacheDir(d.name));

  const caches: CacheEntry[] = await Promise.all(
    matched.map(async (d) => {
      const full   = nodePath.join(cacheRoot, d.name);
      const sizeMb = await getDirSizeMb(full);
      return { name: d.name, path: full, sizeMb };
    }),
  );

  caches.sort((a, b) => b.sizeMb - a.sizeMb);

  const totalSizeMb = Math.round(caches.reduce((s, c) => s + c.sizeMb, 0) * 100) / 100;

  if (dryRun || caches.length === 0) {
    return { caches, totalSizeMb, deleted: false, freedMb: 0 };
  }

  // dryRun:false → delete every cache in `caches`. When appName is set,
  // `caches` is already filtered to the matching subset; when appName is
  // omitted it spans every subdir under ~/Library/Caches (used by the
  // disk-cleanup present_preview flow, where the user already confirmed
  // the bulk-clear via the consolidated category card).
  let freedMb = 0;
  for (const cache of caches) {
    if (!isSafePath(cache.path, cacheRoot)) continue;
    try {
      await fs.rm(cache.path, { recursive: true, force: true });
      freedMb += cache.sizeMb;
    } catch {
      // skip items we can't remove
    }
  }

  return {
    caches,
    totalSizeMb,
    deleted: true,
    freedMb: Math.round(freedMb * 100) / 100,
  };
}

// -- win32 implementation -----------------------------------------------------

async function clearAppCacheWin32(
  appName:    string | undefined,
  dryRun:     boolean,
  deadlineMs: number,
): Promise<{ caches: CacheEntry[]; totalSizeMb: number; deleted: boolean; freedMb: number }> {
  const localAppData = process.env["LOCALAPPDATA"] ?? nodePath.join(os.homedir(), "AppData", "Local");
  const tempDir      = process.env["TEMP"]         ?? nodePath.join(os.homedir(), "AppData", "Local", "Temp");

  const roots = [localAppData, tempDir];
  const seen  = new Set<string>();
  const all:  { name: string; fullPath: string; root: string }[] = [];

  for (const root of roots) {
    let dirents: import("fs").Dirent[];
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (!d.isDirectory() || seen.has(d.name.toLowerCase())) continue;
      if (appName && !d.name.toLowerCase().includes(appName.toLowerCase())) continue;
      // In the bulk (no appName) flow, NEVER recurse-delete a browser vendor
      // dir (holds the full browser profile, not just cache) or a dev cache dir
      // (pip/Yarn) — those are owned by clear_browser_cache / clear_dev_cache.
      // An explicit appName target still wins.
      // See _shared/browserCaches.ts and _shared/devCaches.ts.
      if (!appName && (isWin32BrowserVendorDir(d.name) || isDevCacheDir(d.name))) continue;
      seen.add(d.name.toLowerCase());
      all.push({ name: d.name, fullPath: nodePath.join(root, d.name), root });
    }
  }

  const caches: CacheEntry[] = await Promise.all(
    all.map(async ({ name, fullPath }) => {
      const { sizeBytes } = await getDirSizeBytes(fullPath, deadlineMs);
      return { name, path: fullPath, sizeMb: Math.round((sizeBytes / 1_000_000) * 100) / 100 };
    }),
  );

  caches.sort((a, b) => b.sizeMb - a.sizeMb);
  const totalSizeMb = Math.round(caches.reduce((s, c) => s + c.sizeMb, 0) * 100) / 100;

  if (dryRun || caches.length === 0) {
    return { caches, totalSizeMb, deleted: false, freedMb: 0 };
  }

  // dryRun:false → delete every cache in `caches`. Same semantics as the
  // darwin branch: appName-filtered when set, every cache subdir when omitted.
  let freedMb = 0;
  for (const cache of caches) {
    const root = roots.find((r) => cache.path.startsWith(r));
    if (!root || !isSafePath(cache.path, root)) continue;
    try {
      await fs.rm(cache.path, { recursive: true, force: true });
      freedMb += cache.sizeMb;
    } catch {
      // skip items we can't remove
    }
  }

  return {
    caches,
    totalSizeMb,
    deleted: true,
    freedMb: Math.round(freedMb * 100) / 100,
  };
}

// -- Exported run function ----------------------------------------------------

interface RunCtx { deadlineMs?: number }

export async function run(
  {
    appName,
    dryRun = true,
  }: {
    appName?: string;
    dryRun?:  boolean;
  } = {},
  ctx?: RunCtx,
) {
  const ceilingMs   = ctx?.deadlineMs ?? (Date.now() + 60_000);
  const remainingMs = Math.max(0, ceilingMs - Date.now());
  const internalDeadlineMs = Date.now() + Math.floor(remainingMs * 0.9);

  const platform = os.platform();
  const result   = platform === "win32"
    ? await clearAppCacheWin32(appName, dryRun, internalDeadlineMs)
    : await clearAppCacheDarwin(appName, dryRun);

  return {
    platform,
    appName:  appName ?? null,
    dryRun,
    ...result,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ appName: process.argv[2], dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
