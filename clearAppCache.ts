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
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

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
  schema: {
    appName: z
      .string()
      .optional()
      .describe("App name to target (e.g. 'Slack', 'Chrome'). Omit to list available caches without deleting"),
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
    return Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
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

  // If appName provided, filter to matching subdirs (case-insensitive)
  const matched = appName
    ? subdirs.filter((d) => d.name.toLowerCase().includes(appName.toLowerCase()))
    : subdirs;

  const caches: CacheEntry[] = await Promise.all(
    matched.map(async (d) => {
      const full   = nodePath.join(cacheRoot, d.name);
      const sizeMb = await getDirSizeMb(full);
      return { name: d.name, path: full, sizeMb };
    }),
  );

  caches.sort((a, b) => b.sizeMb - a.sizeMb);

  const totalSizeMb = Math.round(caches.reduce((s, c) => s + c.sizeMb, 0) * 100) / 100;

  if (!appName || dryRun || caches.length === 0) {
    return { caches, totalSizeMb, deleted: false, freedMb: 0 };
  }

  // Only delete when appName is specified and dryRun is false
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

async function getDirSizeMbWin32(dirPath: string): Promise<number> {
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
    return isNaN(bytes) ? 0 : Math.round((bytes / (1024 * 1024)) * 100) / 100;
  } catch {
    return 0;
  }
}

async function clearAppCacheWin32(
  appName: string | undefined,
  dryRun:  boolean,
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
      seen.add(d.name.toLowerCase());
      all.push({ name: d.name, fullPath: nodePath.join(root, d.name), root });
    }
  }

  const caches: CacheEntry[] = await Promise.all(
    all.map(async ({ name, fullPath }) => ({
      name,
      path:   fullPath,
      sizeMb: await getDirSizeMbWin32(fullPath),
    })),
  );

  caches.sort((a, b) => b.sizeMb - a.sizeMb);
  const totalSizeMb = Math.round(caches.reduce((s, c) => s + c.sizeMb, 0) * 100) / 100;

  if (!appName || dryRun || caches.length === 0) {
    return { caches, totalSizeMb, deleted: false, freedMb: 0 };
  }

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

export async function run({
  appName,
  dryRun = true,
}: {
  appName?: string;
  dryRun?:  boolean;
} = {}) {
  const platform = os.platform();
  const result   = platform === "win32"
    ? await clearAppCacheWin32(appName, dryRun)
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
