/**
 * mcp/skills/clearBrowserCache.ts — clear_browser_cache skill
 *
 * Clears cache files for installed browsers (Chrome, Safari, Firefox, Edge).
 * Can target a specific browser or all browsers. Use to free disk space or
 * resolve browser performance issues.
 *
 * Platform strategy
 * -----------------
 * darwin  ~/Library/Caches/{Google/Chrome,com.apple.Safari,Firefox,Microsoft Edge}
 * win32   %LOCALAPPDATA%\{Google\Chrome,Mozilla\Firefox,Microsoft\Edge}\...\Cache
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/clearBrowserCache.ts
 */

import * as fsp      from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { z }         from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "clear_browser_cache",
  description:
    "Clears cache files for installed browsers (Chrome, Safari, Firefox, Edge). " +
    "Can target a specific browser or all browsers. " +
    "Use to free disk space or resolve browser performance issues.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    browser: z
      .enum(["chrome", "safari", "firefox", "edge", "all"])
      .optional()
      .describe("Target browser. Default: all"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report sizes without deleting. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface BrowserCacheResult {
  name:      string;
  cachePath: string;
  sizeMb:    number;
  cleared:   boolean;
  /**
   * Set when the clear operation reported success but post-clear size
   * confirms the data is still there — typically a TCC denial on a
   * protected cache directory. Includes actionable remediation text.
   */
  error?:    string;
}

// -- Helpers ------------------------------------------------------------------

async function getDirSizeMb(dirPath: string): Promise<number> {
  try {
    const entries = await fsp.readdir(dirPath, { recursive: true, withFileTypes: true });
    let totalBytes = 0;
    await Promise.allSettled(
      entries
        .filter((e) => !e.isDirectory())
        .map(async (e) => {
          try {
            const parentPath = (e as unknown as { parentPath?: string; path?: string }).parentPath
              ?? (e as unknown as { path?: string }).path
              ?? dirPath;
            const fullPath = nodePath.join(parentPath, e.name);
            const stat     = await fsp.stat(fullPath);
            totalBytes    += stat.size;
          } catch {
            // skip
          }
        }),
    );
    return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
  } catch {
    return 0;
  }
}

function isSafePath(target: string, allowedRoot: string): boolean {
  const rel = nodePath.relative(allowedRoot, target);
  return !rel.startsWith("..") && !nodePath.isAbsolute(rel);
}

async function processCachePath(
  name:      string,
  cachePath: string,
  dryRun:    boolean,
  safeRoot:  string,
): Promise<BrowserCacheResult> {
  // Check if path exists
  try {
    await fsp.access(cachePath);
  } catch {
    return { name, cachePath, sizeMb: 0, cleared: false };
  }

  const sizeMb = await getDirSizeMb(cachePath);

  if (dryRun || !isSafePath(cachePath, safeRoot)) {
    return { name, cachePath, sizeMb, cleared: false };
  }

  try {
    const entries = await fsp.readdir(cachePath);
    await Promise.allSettled(
      entries.map((entry) =>
        fsp.rm(nodePath.join(cachePath, entry), { recursive: true, force: true }),
      ),
    );

    // ── Silent-failure detection ──────────────────────────────────────────────
    // The rm loop reports success (Promise.allSettled never throws), but
    // individual removes may have been denied silently. Re-measure after
    // the clear: if size barely changed, the cache wasn't actually cleared
    // — almost always a TCC denial on a protected browser cache directory.
    const sizeAfterMb = await getDirSizeMb(cachePath);
    if (sizeMb > 0 && sizeAfterMb >= sizeMb * 0.9) {
      return {
        name, cachePath, sizeMb,
        cleared: false,
        error:
          `Could not clear ${name} cache (${sizeMb} MB still present after ` +
          `the operation). Full Disk Access is required to remove protected ` +
          `browser cache files. Open System Settings → Privacy & Security → ` +
          `Full Disk Access, enable AI Support Agent, then quit and relaunch.`,
      };
    }

    return { name, cachePath, sizeMb, cleared: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EPERM" || code === "EACCES") {
      return {
        name, cachePath, sizeMb,
        cleared: false,
        error:
          `Could not clear ${name} cache — macOS denied access. ` +
          `Open System Settings → Privacy & Security → Full Disk Access, ` +
          `enable AI Support Agent, then quit and relaunch.`,
      };
    }
    return { name, cachePath, sizeMb, cleared: false };
  }
}

// -- darwin implementation ----------------------------------------------------

async function clearBrowserCacheDarwin(
  browser: string,
  dryRun:  boolean,
): Promise<BrowserCacheResult[]> {
  const home      = os.homedir();
  const cacheRoot = nodePath.join(home, "Library", "Caches");

  const browserDefs: { key: string; name: string; path: string }[] = [
    {
      key:  "chrome",
      name: "Chrome",
      path: nodePath.join(cacheRoot, "Google", "Chrome"),
    },
    {
      key:  "safari",
      name: "Safari",
      path: nodePath.join(cacheRoot, "com.apple.Safari"),
    },
    {
      key:  "firefox",
      name: "Firefox",
      path: nodePath.join(cacheRoot, "Firefox"),
    },
    {
      key:  "edge",
      name: "Edge",
      path: nodePath.join(cacheRoot, "Microsoft Edge"),
    },
  ];

  const targets = browser === "all"
    ? browserDefs
    : browserDefs.filter((b) => b.key === browser);

  return Promise.all(
    targets.map((b) => processCachePath(b.name, b.path, dryRun, cacheRoot)),
  );
}

// -- win32 implementation -----------------------------------------------------

async function clearBrowserCacheWin32(
  browser: string,
  dryRun:  boolean,
): Promise<BrowserCacheResult[]> {
  const localAppData = process.env["LOCALAPPDATA"]
    ?? nodePath.join(os.homedir(), "AppData", "Local");

  const browserDefs: { key: string; name: string; path: string }[] = [
    {
      key:  "chrome",
      name: "Chrome",
      path: nodePath.join(localAppData, "Google", "Chrome", "User Data", "Default", "Cache"),
    },
    {
      key:  "firefox",
      name: "Firefox",
      path: nodePath.join(localAppData, "Mozilla", "Firefox", "Profiles"),
    },
    {
      key:  "edge",
      name: "Edge",
      path: nodePath.join(localAppData, "Microsoft", "Edge", "User Data", "Default", "Cache"),
    },
    // Safari is not available on Windows
  ];

  const targets = browser === "all" || browser === "safari"
    ? browserDefs.filter((b) => browser === "all" || b.key === browser)
    : browserDefs.filter((b) => b.key === browser);

  if (browser === "safari") {
    return [{ name: "Safari", cachePath: "N/A", sizeMb: 0, cleared: false }];
  }

  return Promise.all(
    targets.map((b) => processCachePath(b.name, b.path, dryRun, localAppData)),
  );
}

// -- Exported run function ----------------------------------------------------

export async function run({
  browser = "all",
  dryRun  = true,
}: {
  browser?: "chrome" | "safari" | "firefox" | "edge" | "all";
  dryRun?:  boolean;
} = {}) {
  const platform = os.platform();

  const browsers = platform === "win32"
    ? await clearBrowserCacheWin32(browser, dryRun)
    : await clearBrowserCacheDarwin(browser, dryRun);

  const totalSizeMb = Math.round(browsers.reduce((s, b) => s + b.sizeMb, 0) * 100) / 100;
  const freedMb     = Math.round(
    browsers.filter((b) => b.cleared).reduce((s, b) => s + b.sizeMb, 0) * 100,
  ) / 100;

  // Aggregate any per-browser TCC / silent-failure errors into a top-level
  // error string so the soft-error pipeline (execution.ts → log.warn,
  // summarizer → result bubble) surfaces them. Without this, only the
  // per-browser entries carry the message and the user-facing summary
  // typically loses the detail.
  const failedBrowsers = browsers.filter((b) => b.error);
  const error = failedBrowsers.length > 0
    ? failedBrowsers.map((b) => b.error).join(" ")
    : undefined;

  return {
    platform, dryRun, browsers, totalSizeMb, freedMb,
    ...(error ? { error } : {}),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
