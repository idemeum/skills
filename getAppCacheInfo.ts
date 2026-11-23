/**
 * mcp/skills/getAppCacheInfo.ts — get_app_cache_info skill
 *
 * Reports application cache directory sizes (per app) without modifying
 * anything.  Read-only counterpart to `clear_app_cache` — designed for
 * synthesis-then-confirm skills (disk-cleanup) that need a diagnostic
 * size feed for the consolidated present_preview card.
 *
 * Platform strategy
 * -----------------
 * darwin  Scans ~/Library/Caches — subdirectories per application.
 * win32   Known cache folders only — see _shared/win32AppCaches.ts.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getAppCacheInfo.ts
 *
 * NOTE: the darwin enumeration is duplicated from `clearAppCache.ts` — keep
 * in sync if cache-directory roots or sizing approach change. win32 lists
 * through _shared/win32AppCaches.ts, shared with clearAppCache.ts.
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";

import { isDarwin, isWin32 } from "./_shared/platform";
import { getDirSizeBytes as getDirSizeBytesShared } from "./_shared/dirSize";
import { formatBytes } from "./_shared/formatBytes";
import { DARWIN_BROWSER_CACHE_DIR_NAMES } from "./_shared/browserCaches";
import { listWin32AppCaches } from "./_shared/win32AppCaches";
import { isDevCacheDir } from "./_shared/devCaches";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_app_cache_info",
  description:
    "Reports per-application cache directory sizes on macOS (~/Library/Caches) " +
    "or Windows (known cache folders in %LOCALAPPDATA% / %APPDATA%, and %TEMP%) without deleting anything. Read-only " +
    "counterpart to clear_app_cache.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  // Walks every subdir of ~/Library/Caches; on a populated home this exceeds
  // the default 60 s ceiling. Tool honours ctx.deadlineMs internally and
  // returns partial results before this hard timeout fires.
  timeoutMs:       180_000,
  outputKeys: ["platform","caches","totalBytes","totalHuman","errors"],
  schema:          {},
} as const;

// -- Types --------------------------------------------------------------------

export interface AppCacheEntry {
  name:      string;
  path:      string;
  sizeBytes: number;
}

export interface GetAppCacheInfoResult {
  platform:   NodeJS.Platform;
  caches:     AppCacheEntry[];
  totalBytes: number;
  /**
   * Pre-formatted human-readable size of `totalBytes`, computed via the
   * shared formatBytes helper (decimal/SI units — matches Finder + Explorer).
   * disk-cleanup SKILL.md substitutes this verbatim into the cleanup card's
   * `{size}` placeholder for the app-cache row, so the LLM doesn't have to
   * do byte math itself (and pick binary-vs-decimal inconsistently).
   */
  totalHuman: string;
  errors?:    Array<{ scope: string; message: string }>;
}

// -- Helpers ------------------------------------------------------------------


// -- darwin -------------------------------------------------------------------

async function getAppCacheInfoDarwin(deadlineMs: number): Promise<GetAppCacheInfoResult> {
  const cacheRoot = nodePath.join(os.homedir(), "Library", "Caches");
  const errors: GetAppCacheInfoResult["errors"] = [];

  let dirents: import("fs").Dirent[];
  try {
    dirents = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch (err) {
    errors.push({ scope: "cache-root", message: (err as Error).message });
    return { platform: "darwin", caches: [], totalBytes: 0, totalHuman: formatBytes(0), errors };
  }

  // Exclude browser + dev cache dirs — the browser-cache / dev-cache tools own
  // them. Without this, app-cache double-counts them in the cleanup card and
  // clear_app_cache deletes them before clear_browser_cache / clear_dev_cache
  // run. See _shared/browserCaches.ts and _shared/devCaches.ts.
  const subdirs = dirents.filter(
    (d) => d.isDirectory()
      && !DARWIN_BROWSER_CACHE_DIR_NAMES.has(d.name)
      && !isDevCacheDir(d.name),
  );
  let anyPartial = false;
  const caches: AppCacheEntry[] = await Promise.all(
    subdirs.map(async (d) => {
      const full = nodePath.join(cacheRoot, d.name);
      const { sizeBytes, partial } = await getDirSizeBytesShared(full, deadlineMs);
      if (partial) anyPartial = true;
      return { name: d.name, path: full, sizeBytes };
    }),
  );

  caches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = caches.reduce((s, c) => s + c.sizeBytes, 0);

  if (anyPartial) {
    errors.push({
      scope:   "deadline",
      message: "Cache scan exceeded the per-tool deadline; sizes are partial.",
    });
  }

  return {
    platform: "darwin",
    caches,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// -- win32 --------------------------------------------------------------------

async function getAppCacheInfoWin32(deadlineMs: number): Promise<GetAppCacheInfoResult> {
  // The same folders clear_app_cache clears — known cache folders only, never
  // the top-level folders of %LOCALAPPDATA%. See _shared/win32AppCaches.ts.
  const { targets, errors } = await listWin32AppCaches();
  const all = targets.map((t) => ({ name: t.name, fullPath: t.path }));

  let anyPartial = false;
  const caches: AppCacheEntry[] = await Promise.all(
    all.map(async ({ name, fullPath }) => {
      const { sizeBytes, partial } = await getDirSizeBytesShared(fullPath, deadlineMs);
      if (partial) anyPartial = true;
      return { name, path: fullPath, sizeBytes };
    }),
  );

  caches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = caches.reduce((s, c) => s + c.sizeBytes, 0);

  if (anyPartial) {
    errors.push({
      scope:   "deadline",
      message: "Cache scan exceeded the per-tool deadline; sizes are partial.",
    });
  }

  return {
    platform: "win32",
    caches,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// -- Exported run -------------------------------------------------------------

interface RunCtx { deadlineMs?: number }

export async function run(
  _args: Record<string, never> = {},
  ctx?:  RunCtx,
): Promise<GetAppCacheInfoResult> {
  // Internal budget = 90% of the G4 deadline, leaving 10% headroom to
  // serialize the partial result and return through G4 before its
  // Promise.race rejects.
  const ceilingMs    = ctx?.deadlineMs ?? (Date.now() + 60_000);
  const remainingMs  = Math.max(0, ceilingMs - Date.now());
  const internalDeadlineMs = Date.now() + Math.floor(remainingMs * 0.9);

  if (isDarwin()) return getAppCacheInfoDarwin(internalDeadlineMs);
  if (isWin32())  return getAppCacheInfoWin32(internalDeadlineMs);
  return {
    platform: os.platform(),
    caches:   [],
    totalBytes: 0,
    totalHuman: formatBytes(0),
    errors:   [{ scope: "platform", message: `unsupported platform: ${os.platform()}` }],
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
