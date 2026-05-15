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

async function getDirSizeBytes(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { recursive: true, withFileTypes: true });
    let totalBytes = 0;
    await Promise.all(
      entries
        .filter((e) => !e.isDirectory())
        .map(async (e) => {
          try {
            const fullPath = nodePath.join(
              e.parentPath ?? (e as unknown as { path: string }).path ?? dirPath,
              e.name,
            );
            const stat = await fs.stat(fullPath);
            totalBytes += stat.size;
          } catch { /* skip inaccessible */ }
        }),
    );
    return totalBytes;
  } catch {
    return 0;
  }
}

async function measureIfExists(browser: string, profile: string, path: string): Promise<BrowserCacheEntry | null> {
  try {
    await fs.access(path);
  } catch {
    return null;
  }
  const sizeBytes = await getDirSizeBytes(path);
  return { browser, profile, path, sizeBytes };
}

// -- darwin -------------------------------------------------------------------

async function getBrowserCacheInfoDarwin(): Promise<GetBrowserCacheInfoResult> {
  const cacheRoot = nodePath.join(os.homedir(), "Library", "Caches");
  const defs: Array<{ browser: string; path: string }> = [
    { browser: "Chrome",  path: nodePath.join(cacheRoot, "Google", "Chrome") },
    { browser: "Safari",  path: nodePath.join(cacheRoot, "com.apple.Safari") },
    { browser: "Firefox", path: nodePath.join(cacheRoot, "Firefox") },
    { browser: "Edge",    path: nodePath.join(cacheRoot, "Microsoft Edge") },
  ];

  const measured = await Promise.all(
    defs.map((d) => measureIfExists(d.browser, "default", d.path)),
  );
  const browsers = measured.filter((b): b is BrowserCacheEntry => b !== null);
  browsers.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = browsers.reduce((s, b) => s + b.sizeBytes, 0);

  return { platform: "darwin", browsers, totalBytes };
}

// -- win32 --------------------------------------------------------------------

async function getBrowserCacheInfoWin32(): Promise<GetBrowserCacheInfoResult> {
  const localAppData = process.env["LOCALAPPDATA"]
    ?? nodePath.join(os.homedir(), "AppData", "Local");

  const defs: Array<{ browser: string; path: string }> = [
    { browser: "Chrome",  path: nodePath.join(localAppData, "Google", "Chrome", "User Data", "Default", "Cache") },
    { browser: "Firefox", path: nodePath.join(localAppData, "Mozilla", "Firefox", "Profiles") },
    { browser: "Edge",    path: nodePath.join(localAppData, "Microsoft", "Edge", "User Data", "Default", "Cache") },
  ];

  const measured = await Promise.all(
    defs.map((d) => measureIfExists(d.browser, "default", d.path)),
  );
  const browsers = measured.filter((b): b is BrowserCacheEntry => b !== null);
  browsers.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = browsers.reduce((s, b) => s + b.sizeBytes, 0);

  return { platform: "win32", browsers, totalBytes };
}

// -- Exported run -------------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetBrowserCacheInfoResult> {
  if (isDarwin()) return getBrowserCacheInfoDarwin();
  if (isWin32())  return getBrowserCacheInfoWin32();
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
