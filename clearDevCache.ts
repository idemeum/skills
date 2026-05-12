/**
 * mcp/skills/clearDevCache.ts — clear_dev_cache skill
 *
 * Clears developer tool caches to free disk space.  Supports npm, yarn,
 * pnpm, pip, gradle, maven.  Reports sizes before clearing.  Safe to
 * clear — tools rebuild caches as needed.
 *
 * Platform strategy
 * -----------------
 * darwin  npm/yarn/pnpm via their CLI; pip/gradle/maven via directory paths
 *         under ~/Library/Caches and ~/.gradle/.m2
 * win32   Same CLIs where available; paths from %APPDATA%/%LOCALAPPDATA%
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/clearDevCache.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import * as fs       from "fs/promises";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "clear_dev_cache",
  description:
    "Clears developer tool caches to free disk space. " +
    "Supports npm, yarn, pnpm, pip, gradle, maven. " +
    "Reports sizes before clearing. " +
    "Safe to clear — tools rebuild caches as needed.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    tools: z
      .array(z.enum(["npm", "yarn", "pnpm", "pip", "gradle", "maven", "all"]))
      .optional()
      .describe("Tools to clear. Default: all detected"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report sizes without clearing. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface CacheEntry {
  tool:      string;
  path:      string | null;
  sizeMb:    number;
  available: boolean;
  cleared:   boolean;
}

interface ClearDevCacheResult {
  caches:       CacheEntry[];
  totalSizeMb:  number;
  freedMb:      number;
}

// -- Helpers ------------------------------------------------------------------

const ALL_TOOLS = ["npm", "yarn", "pnpm", "pip", "gradle", "maven"] as const;
type ToolName = typeof ALL_TOOLS[number];

async function getDirSizeMb(dirPath: string): Promise<number> {
  try {
    if (os.platform() === "win32") {
      // PowerShell for directory size
      const encoded = Buffer.from(
        `(Get-ChildItem -LiteralPath '${dirPath.replace(/'/g, "''")}' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`,
        "utf16le",
      ).toString("base64");
      const { stdout } = await execAsync(
        `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
        { maxBuffer: 10 * 1024 * 1024 },
      );
      const bytes = parseInt(stdout.trim(), 10);
      return isNaN(bytes) ? 0 : Math.round((bytes / (1024 * 1024)) * 10) / 10;
    } else {
      const safePath = dirPath.replace(/'/g, "'\\''");
      const { stdout } = await execAsync(
        `du -sk '${safePath}' 2>/dev/null`,
        { maxBuffer: 10 * 1024 * 1024, shell: "/bin/bash" },
      );
      const kb = parseInt(stdout.split("\t")[0], 10);
      return isNaN(kb) ? 0 : Math.round((kb / 1024) * 10) / 10;
    }
  } catch {
    return 0;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function deleteDirContents(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const check = os.platform() === "win32" ? `where ${cmd}` : `which ${cmd}`;
    await execAsync(check);
    return true;
  } catch {
    return false;
  }
}

// -- Per-tool handlers --------------------------------------------------------

async function handleNpm(dryRun: boolean): Promise<CacheEntry> {
  const tool = "npm";
  if (!(await commandExists("npm"))) {
    return { tool, path: null, sizeMb: 0, available: false, cleared: false };
  }

  // Get cache dir
  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("npm config get cache");
    cachePath = stdout.trim();
  } catch { /* ignore */ }

  const sizeMb = cachePath ? await getDirSizeMb(cachePath) : 0;

  let cleared = false;
  if (!dryRun) {
    try {
      await execAsync("npm cache clean --force");
      cleared = true;
    } catch { cleared = false; }
  }

  return { tool, path: cachePath, sizeMb, available: true, cleared };
}

async function handleYarn(dryRun: boolean): Promise<CacheEntry> {
  const tool = "yarn";
  if (!(await commandExists("yarn"))) {
    return { tool, path: null, sizeMb: 0, available: false, cleared: false };
  }

  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("yarn cache dir");
    cachePath = stdout.trim();
  } catch { /* ignore */ }

  const sizeMb = cachePath ? await getDirSizeMb(cachePath) : 0;

  let cleared = false;
  if (!dryRun && cachePath) {
    try {
      await deleteDirContents(cachePath);
      cleared = true;
    } catch { cleared = false; }
  }

  return { tool, path: cachePath, sizeMb, available: true, cleared };
}

async function handlePnpm(dryRun: boolean): Promise<CacheEntry> {
  const tool = "pnpm";
  if (!(await commandExists("pnpm"))) {
    return { tool, path: null, sizeMb: 0, available: false, cleared: false };
  }

  let cachePath: string | null = null;
  try {
    const { stdout } = await execAsync("pnpm store path");
    cachePath = stdout.trim();
  } catch { /* ignore */ }

  const sizeMb = cachePath ? await getDirSizeMb(cachePath) : 0;

  let cleared = false;
  if (!dryRun) {
    try {
      await execAsync("pnpm store prune");
      cleared = true;
    } catch { cleared = false; }
  }

  return { tool, path: cachePath, sizeMb, available: true, cleared };
}

async function handlePip(dryRun: boolean): Promise<CacheEntry> {
  const tool = "pip";
  const home  = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env.LOCALAPPDATA ?? nodePath.join(home, "AppData", "Local"), "pip", "Cache")
    : nodePath.join(home, "Library", "Caches", "pip");

  const available = await pathExists(cachePath);
  const sizeMb    = available ? await getDirSizeMb(cachePath) : 0;

  let cleared = false;
  if (!dryRun && available) {
    try {
      // Try pip cache purge first (pip 20.1+)
      try {
        const pipCmd = (await commandExists("pip3")) ? "pip3" : "pip";
        await execAsync(`${pipCmd} cache purge`);
      } catch {
        await deleteDirContents(cachePath);
      }
      cleared = true;
    } catch { cleared = false; }
  }

  return { tool, path: cachePath, sizeMb, available, cleared };
}

async function handleGradle(dryRun: boolean): Promise<CacheEntry> {
  const tool       = "gradle";
  const home       = os.homedir();
  const cachePath  = os.platform() === "win32"
    ? nodePath.join(process.env.USERPROFILE ?? home, ".gradle", "caches")
    : nodePath.join(home, ".gradle", "caches");

  const available = await pathExists(cachePath);
  const sizeMb    = available ? await getDirSizeMb(cachePath) : 0;

  let cleared = false;
  if (!dryRun && available) {
    try {
      await deleteDirContents(cachePath);
      cleared = true;
    } catch { cleared = false; }
  }

  return { tool, path: cachePath, sizeMb, available, cleared };
}

async function handleMaven(dryRun: boolean): Promise<CacheEntry> {
  const tool      = "maven";
  const home      = os.homedir();
  const cachePath = os.platform() === "win32"
    ? nodePath.join(process.env.USERPROFILE ?? home, ".m2", "repository")
    : nodePath.join(home, ".m2", "repository");

  const available = await pathExists(cachePath);
  const sizeMb    = available ? await getDirSizeMb(cachePath) : 0;

  let cleared = false;
  if (!dryRun && available) {
    try {
      await deleteDirContents(cachePath);
      cleared = true;
    } catch { cleared = false; }
  }

  return { tool, path: cachePath, sizeMb, available, cleared };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  tools  = ["all"],
  dryRun = true,
}: {
  tools?:  Array<"npm" | "yarn" | "pnpm" | "pip" | "gradle" | "maven" | "all">;
  dryRun?: boolean;
} = {}) {
  const selected: ToolName[] = tools.includes("all")
    ? [...ALL_TOOLS]
    : (tools.filter((t) => t !== "all") as ToolName[]);

  const handlers: Record<ToolName, (dryRun: boolean) => Promise<CacheEntry>> = {
    npm:    handleNpm,
    yarn:   handleYarn,
    pnpm:   handlePnpm,
    pip:    handlePip,
    gradle: handleGradle,
    maven:  handleMaven,
  };

  const caches = await Promise.all(
    selected.map((t) => handlers[t](dryRun)),
  );

  const totalSizeMb = Math.round(caches.reduce((acc, c) => acc + c.sizeMb, 0) * 10) / 10;
  const freedMb     = dryRun
    ? 0
    : Math.round(caches.filter((c) => c.cleared).reduce((acc, c) => acc + c.sizeMb, 0) * 10) / 10;

  return { caches, totalSizeMb, freedMb };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
