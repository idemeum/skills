/**
 * mcp/skills/getDevCacheInfo.ts — get_dev_cache_info skill
 *
 * Reports developer-tool cache sizes (npm, yarn, pnpm, pip, gradle,
 * maven) without modifying anything.  Read-only counterpart to
 * `clear_dev_cache`.
 *
 * Platform strategy
 * -----------------
 * darwin/linux  CLI lookup for npm/yarn/pnpm; fixed-path probes for
 *               pip (~/Library/Caches/pip), gradle (~/.gradle/caches),
 *               maven (~/.m2/repository).
 * win32         Same CLIs; pip in %LOCALAPPDATA%\pip\Cache; gradle/maven
 *               under %USERPROFILE%.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getDevCacheInfo.ts
 *
 * NOTE: cache-path resolution is duplicated from `clearDevCache.ts` —
 * keep in sync if tool-specific cache lookup logic changes.
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";

import { execAsync } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_dev_cache_info",
  description:
    "Reports developer-tool cache sizes (npm, yarn, pnpm, pip, gradle, maven) " +
    "without clearing anything. Read-only counterpart to clear_dev_cache.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   [],
  schema:          {},
} as const;

// -- Types --------------------------------------------------------------------

export interface DevCacheEntry {
  tool:      "npm" | "yarn" | "pnpm" | "pip" | "gradle" | "maven";
  path:      string | null;
  sizeBytes: number;
  available: boolean;
}

export interface GetDevCacheInfoResult {
  platform:   NodeJS.Platform;
  caches:     DevCacheEntry[];
  totalBytes: number;
  errors?:    Array<{ scope: string; message: string }>;
}

// -- Helpers ------------------------------------------------------------------

async function commandExists(cmd: string): Promise<boolean> {
  const probe = os.platform() === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
  try {
    await execAsync(probe);
    return true;
  } catch {
    return false;
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
          } catch { /* skip */ }
        }),
    );
    return totalBytes;
  } catch {
    return 0;
  }
}

// -- Tool-specific cache resolvers --------------------------------------------

async function probeNpm(): Promise<DevCacheEntry> {
  if (!(await commandExists("npm"))) return { tool: "npm", path: null, sizeBytes: 0, available: false };
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("npm config get cache");
    cachePath = stdout.trim();
  } catch { /* ignore */ }
  const sizeBytes = cachePath ? await getDirSizeBytes(cachePath) : 0;
  return { tool: "npm", path: cachePath, sizeBytes, available: true };
}

async function probeYarn(): Promise<DevCacheEntry> {
  if (!(await commandExists("yarn"))) return { tool: "yarn", path: null, sizeBytes: 0, available: false };
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("yarn cache dir");
    cachePath = stdout.trim();
  } catch { /* ignore */ }
  const sizeBytes = cachePath ? await getDirSizeBytes(cachePath) : 0;
  return { tool: "yarn", path: cachePath, sizeBytes, available: true };
}

async function probePnpm(): Promise<DevCacheEntry> {
  if (!(await commandExists("pnpm"))) return { tool: "pnpm", path: null, sizeBytes: 0, available: false };
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("pnpm store path");
    cachePath = stdout.trim();
  } catch { /* ignore */ }
  const sizeBytes = cachePath ? await getDirSizeBytes(cachePath) : 0;
  return { tool: "pnpm", path: cachePath, sizeBytes, available: true };
}

async function probePip(): Promise<DevCacheEntry> {
  const home = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env["LOCALAPPDATA"] ?? nodePath.join(home, "AppData", "Local"), "pip", "Cache")
    : nodePath.join(home, "Library", "Caches", "pip");
  const available = await pathExists(cachePath);
  const sizeBytes = available ? await getDirSizeBytes(cachePath) : 0;
  return { tool: "pip", path: cachePath, sizeBytes, available };
}

async function probeGradle(): Promise<DevCacheEntry> {
  const home = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env["USERPROFILE"] ?? home, ".gradle", "caches")
    : nodePath.join(home, ".gradle", "caches");
  const available = await pathExists(cachePath);
  const sizeBytes = available ? await getDirSizeBytes(cachePath) : 0;
  return { tool: "gradle", path: cachePath, sizeBytes, available };
}

async function probeMaven(): Promise<DevCacheEntry> {
  const home = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env["USERPROFILE"] ?? home, ".m2", "repository")
    : nodePath.join(home, ".m2", "repository");
  const available = await pathExists(cachePath);
  const sizeBytes = available ? await getDirSizeBytes(cachePath) : 0;
  return { tool: "maven", path: cachePath, sizeBytes, available };
}

// -- Exported run -------------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetDevCacheInfoResult> {
  const caches = await Promise.all([
    probeNpm(), probeYarn(), probePnpm(), probePip(), probeGradle(), probeMaven(),
  ]);
  caches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = caches.reduce((s, c) => s + c.sizeBytes, 0);
  return { platform: os.platform(), caches, totalBytes };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
