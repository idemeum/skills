/**
 * mcp/skills/getBrowserCacheInfo.ts — get_browser_cache_info skill
 *
 * Reports per-browser cache directory sizes without modifying anything.
 * Read-only counterpart to `clear_browser_cache` — designed for
 * synthesis-then-confirm skills that need a diagnostic size feed for
 * the consolidated present_preview card.
 *
 * Platform strategy
 * -----------------
 * darwin  ~/Library/Caches/{Google/Chrome,com.apple.Safari,Firefox,Microsoft Edge}
 * win32   %LOCALAPPDATA%\{Google\Chrome,Mozilla\Firefox,Microsoft\Edge}\…\Cache
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getBrowserCacheInfo.ts
 *
 * NOTE: cache root resolution is duplicated from `clearBrowserCache.ts`
 * — keep in sync if browser cache paths change.
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";

import { isDarwin, isWin32 } from "./_shared/platform";
import { getDirSizeBytes as getDirSizeBytesShared } from "./_shared/dirSize";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_browser_cache_info",
  description:
    "Reports per-browser cache directory sizes (Chrome, Safari, Firefox, Edge) " +
    "without clearing anything. Read-only counterpart to clear_browser_cache.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  // Browser caches can be many GB and millions of small files; the default
  // 60 s ceiling isn't enough on populated home directories. Tool honours
  // ctx.deadlineMs internally and returns partial results before this
  // hard timeout fires.
  timeoutMs:       180_000,
  schema:          {},
} as const;

// -- Types --------------------------------------------------------------------

export interface BrowserCacheEntry {
  browser:   string;
  profile:   string;
  path:      string;
  sizeBytes: number;
}

export interface GetBrowserCacheInfoResult {
  platform:   NodeJS.Platform;
  browsers:   BrowserCacheEntry[];
  totalBytes: number;
  errors?:    Array<{ scope: string; message: string }>;
}

// -- Helpers ------------------------------------------------------------------

async function measureIfExists(
  browser:    string,
  profile:    string,
  path:       string,
  deadlineMs: number,
): Promise<{ entry: BrowserCacheEntry; partial: boolean } | null> {
  try {
    await fs.access(path);
  } catch {
    return null;
  }
  const { sizeBytes, partial } = await getDirSizeBytesShared(path, deadlineMs);
  return { entry: { browser, profile, path, sizeBytes }, partial };
}

// -- darwin -------------------------------------------------------------------

async function getBrowserCacheInfoDarwin(deadlineMs: number): Promise<GetBrowserCacheInfoResult> {
  const cacheRoot = nodePath.join(os.homedir(), "Library", "Caches");
  const defs: Array<{ browser: string; path: string }> = [
    { browser: "Chrome",  path: nodePath.join(cacheRoot, "Google", "Chrome") },
    { browser: "Safari",  path: nodePath.join(cacheRoot, "com.apple.Safari") },
    { browser: "Firefox", path: nodePath.join(cacheRoot, "Firefox") },
    { browser: "Edge",    path: nodePath.join(cacheRoot, "Microsoft Edge") },
  ];

  const measured = await Promise.all(
    defs.map((d) => measureIfExists(d.browser, "default", d.path, deadlineMs)),
  );
  const present  = measured.filter((m): m is { entry: BrowserCacheEntry; partial: boolean } => m !== null);
  const browsers = present.map((m) => m.entry);
  browsers.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = browsers.reduce((s, b) => s + b.sizeBytes, 0);
  const anyPartial = present.some((m) => m.partial);

  return {
    platform: "darwin",
    browsers,
    totalBytes,
    ...(anyPartial
      ? { errors: [{ scope: "deadline", message: "Browser cache scan exceeded the per-tool deadline; sizes are partial." }] }
      : {}),
  };
}

// -- win32 --------------------------------------------------------------------

async function getBrowserCacheInfoWin32(deadlineMs: number): Promise<GetBrowserCacheInfoResult> {
  const localAppData = process.env["LOCALAPPDATA"]
    ?? nodePath.join(os.homedir(), "AppData", "Local");

  const defs: Array<{ browser: string; path: string }> = [
    { browser: "Chrome",  path: nodePath.join(localAppData, "Google", "Chrome", "User Data", "Default", "Cache") },
    { browser: "Firefox", path: nodePath.join(localAppData, "Mozilla", "Firefox", "Profiles") },
    { browser: "Edge",    path: nodePath.join(localAppData, "Microsoft", "Edge", "User Data", "Default", "Cache") },
  ];

  const measured = await Promise.all(
    defs.map((d) => measureIfExists(d.browser, "default", d.path, deadlineMs)),
  );
  const present  = measured.filter((m): m is { entry: BrowserCacheEntry; partial: boolean } => m !== null);
  const browsers = present.map((m) => m.entry);
  browsers.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = browsers.reduce((s, b) => s + b.sizeBytes, 0);
  const anyPartial = present.some((m) => m.partial);

  return {
    platform: "win32",
    browsers,
    totalBytes,
    ...(anyPartial
      ? { errors: [{ scope: "deadline", message: "Browser cache scan exceeded the per-tool deadline; sizes are partial." }] }
      : {}),
  };
}

// -- Exported run -------------------------------------------------------------

interface RunCtx { deadlineMs?: number }

export async function run(
  _args: Record<string, never> = {},
  ctx?:  RunCtx,
): Promise<GetBrowserCacheInfoResult> {
  // Internal budget = 90% of the G4 deadline.
  const ceilingMs    = ctx?.deadlineMs ?? (Date.now() + 60_000);
  const remainingMs  = Math.max(0, ceilingMs - Date.now());
  const internalDeadlineMs = Date.now() + Math.floor(remainingMs * 0.9);

  if (isDarwin()) return getBrowserCacheInfoDarwin(internalDeadlineMs);
  if (isWin32())  return getBrowserCacheInfoWin32(internalDeadlineMs);
  return {
    platform:   os.platform(),
    browsers:   [],
    totalBytes: 0,
    errors:     [{ scope: "platform", message: `unsupported platform: ${os.platform()}` }],
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
