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
 * win32   Scans %LOCALAPPDATA% and %TEMP% for app cache folders.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getAppCacheInfo.ts
 *
 * NOTE: enumeration logic is duplicated from `clearAppCache.ts` — keep
 * in sync if cache-directory roots or sizing approach change.
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";

import { execAsync, isDarwin, isWin32 } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_app_cache_info",
  description:
    "Reports per-application cache directory sizes on macOS (~/Library/Caches) " +
    "or Windows (%LOCALAPPDATA% / %TEMP%) without deleting anything. Read-only " +
    "counterpart to clear_app_cache.",
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

export interface AppCacheEntry {
  name:      string;
  path:      string;
  sizeBytes: number;
}

export interface GetAppCacheInfoResult {
  platform:   NodeJS.Platform;
  caches:     AppCacheEntry[];
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

async function getDirSizeBytesWin32(dirPath: string): Promise<number> {
  try {
    const encoded = Buffer.from(
      `(Get-ChildItem -LiteralPath '${dirPath.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`,
      "utf16le",
    ).toString("base64");
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { maxBuffer: 5 * 1024 * 1024 },
    );
    const bytes = parseFloat(stdout.trim());
    return isNaN(bytes) ? 0 : Math.round(bytes);
  } catch {
    return 0;
  }
}

// -- darwin -------------------------------------------------------------------

async function getAppCacheInfoDarwin(): Promise<GetAppCacheInfoResult> {
  const cacheRoot = nodePath.join(os.homedir(), "Library", "Caches");
  const errors: GetAppCacheInfoResult["errors"] = [];

  let dirents: import("fs").Dirent[];
  try {
    dirents = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch (err) {
    errors.push({ scope: "cache-root", message: (err as Error).message });
    return { platform: "darwin", caches: [], totalBytes: 0, errors };
  }

  const subdirs = dirents.filter((d) => d.isDirectory());
  const caches: AppCacheEntry[] = await Promise.all(
    subdirs.map(async (d) => {
      const full      = nodePath.join(cacheRoot, d.name);
      const sizeBytes = await getDirSizeBytes(full);
      return { name: d.name, path: full, sizeBytes };
    }),
  );

  caches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = caches.reduce((s, c) => s + c.sizeBytes, 0);

  return {
    platform: "darwin",
    caches,
    totalBytes,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// -- win32 --------------------------------------------------------------------

async function getAppCacheInfoWin32(): Promise<GetAppCacheInfoResult> {
  const localAppData = process.env["LOCALAPPDATA"] ?? nodePath.join(os.homedir(), "AppData", "Local");
  const tempDir      = process.env["TEMP"]         ?? nodePath.join(localAppData, "Temp");

  const roots = [localAppData, tempDir];
  const seen  = new Set<string>();
  const errors: GetAppCacheInfoResult["errors"] = [];
  const all:  { name: string; fullPath: string }[] = [];

  for (const root of roots) {
    let dirents: import("fs").Dirent[];
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      errors.push({ scope: root, message: (err as Error).message });
      continue;
    }
    for (const d of dirents) {
      if (!d.isDirectory() || seen.has(d.name.toLowerCase())) continue;
      seen.add(d.name.toLowerCase());
      all.push({ name: d.name, fullPath: nodePath.join(root, d.name) });
    }
  }

  const caches: AppCacheEntry[] = await Promise.all(
    all.map(async ({ name, fullPath }) => ({
      name,
      path:      fullPath,
      sizeBytes: await getDirSizeBytesWin32(fullPath),
    })),
  );

  caches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = caches.reduce((s, c) => s + c.sizeBytes, 0);

  return {
    platform: "win32",
    caches,
    totalBytes,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

// -- Exported run -------------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetAppCacheInfoResult> {
  if (isDarwin()) return getAppCacheInfoDarwin();
  if (isWin32())  return getAppCacheInfoWin32();
  return {
    platform: os.platform(),
    caches:   [],
    totalBytes: 0,
    errors:   [{ scope: "platform", message: `unsupported platform: ${os.platform()}` }],
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
