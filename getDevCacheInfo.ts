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
import { getDirSizeBytes as getDirSizeBytesShared } from "./_shared/dirSize";

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
  // Gradle/maven/npm caches can be tens of GB; the default 60 s ceiling
  // isn't enough on developer machines. Tool honours ctx.deadlineMs
  // internally and returns partial results before this hard timeout fires.
  timeoutMs:       180_000,
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

async function sizeOf(path: string, deadlineMs: number): Promise<{ sizeBytes: number; partial: boolean }> {
  return getDirSizeBytesShared(path, deadlineMs);
}

// -- Tool-specific cache resolvers --------------------------------------------

type ProbeResult = { entry: DevCacheEntry; partial: boolean };

async function probeNpm(deadlineMs: number): Promise<ProbeResult> {
  if (!(await commandExists("npm"))) return { entry: { tool: "npm", path: null, sizeBytes: 0, available: false }, partial: false };
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("npm config get cache");
    cachePath = stdout.trim();
  } catch { /* ignore */ }
  const { sizeBytes, partial } = cachePath ? await sizeOf(cachePath, deadlineMs) : { sizeBytes: 0, partial: false };
  return { entry: { tool: "npm", path: cachePath, sizeBytes, available: true }, partial };
}

async function probeYarn(deadlineMs: number): Promise<ProbeResult> {
  if (!(await commandExists("yarn"))) return { entry: { tool: "yarn", path: null, sizeBytes: 0, available: false }, partial: false };
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("yarn cache dir");
    cachePath = stdout.trim();
  } catch { /* ignore */ }
  const { sizeBytes, partial } = cachePath ? await sizeOf(cachePath, deadlineMs) : { sizeBytes: 0, partial: false };
  return { entry: { tool: "yarn", path: cachePath, sizeBytes, available: true }, partial };
}

async function probePnpm(deadlineMs: number): Promise<ProbeResult> {
  if (!(await commandExists("pnpm"))) return { entry: { tool: "pnpm", path: null, sizeBytes: 0, available: false }, partial: false };
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("pnpm store path");
    cachePath = stdout.trim();
  } catch { /* ignore */ }
  const { sizeBytes, partial } = cachePath ? await sizeOf(cachePath, deadlineMs) : { sizeBytes: 0, partial: false };
  return { entry: { tool: "pnpm", path: cachePath, sizeBytes, available: true }, partial };
}

async function probePip(deadlineMs: number): Promise<ProbeResult> {
  const home = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env["LOCALAPPDATA"] ?? nodePath.join(home, "AppData", "Local"), "pip", "Cache")
    : nodePath.join(home, "Library", "Caches", "pip");
  const available = await pathExists(cachePath);
  const { sizeBytes, partial } = available ? await sizeOf(cachePath, deadlineMs) : { sizeBytes: 0, partial: false };
  return { entry: { tool: "pip", path: cachePath, sizeBytes, available }, partial };
}

async function probeGradle(deadlineMs: number): Promise<ProbeResult> {
  const home = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env["USERPROFILE"] ?? home, ".gradle", "caches")
    : nodePath.join(home, ".gradle", "caches");
  const available = await pathExists(cachePath);
  const { sizeBytes, partial } = available ? await sizeOf(cachePath, deadlineMs) : { sizeBytes: 0, partial: false };
  return { entry: { tool: "gradle", path: cachePath, sizeBytes, available }, partial };
}

async function probeMaven(deadlineMs: number): Promise<ProbeResult> {
  const home = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env["USERPROFILE"] ?? home, ".m2", "repository")
    : nodePath.join(home, ".m2", "repository");
  const available = await pathExists(cachePath);
  const { sizeBytes, partial } = available ? await sizeOf(cachePath, deadlineMs) : { sizeBytes: 0, partial: false };
  return { entry: { tool: "maven", path: cachePath, sizeBytes, available }, partial };
}

// -- Exported run -------------------------------------------------------------

interface RunCtx { deadlineMs?: number }

export async function run(
  _args: Record<string, never> = {},
  ctx?:  RunCtx,
): Promise<GetDevCacheInfoResult> {
  const ceilingMs    = ctx?.deadlineMs ?? (Date.now() + 60_000);
  const remainingMs  = Math.max(0, ceilingMs - Date.now());
  const internalDeadlineMs = Date.now() + Math.floor(remainingMs * 0.9);

  const probes = await Promise.all([
    probeNpm(internalDeadlineMs),
    probeYarn(internalDeadlineMs),
    probePnpm(internalDeadlineMs),
    probePip(internalDeadlineMs),
    probeGradle(internalDeadlineMs),
    probeMaven(internalDeadlineMs),
  ]);
  const caches = probes.map((p) => p.entry);
  caches.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = caches.reduce((s, c) => s + c.sizeBytes, 0);
  const anyPartial = probes.some((p) => p.partial);

  return {
    platform: os.platform(),
    caches,
    totalBytes,
    ...(anyPartial
      ? { errors: [{ scope: "deadline", message: "Dev cache scan exceeded the per-tool deadline; sizes are partial." }] }
      : {}),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
