/**
 * mcp/skills/clearXcodeDerivedData.ts — clear_xcode_derived_data skill
 *
 * Clears Xcode's DerivedData folder containing build artifacts that commonly
 * grow to 10-30 GB. Optionally clears Xcode Archives and device support files.
 * macOS only.
 *
 * Platform strategy
 * -----------------
 * darwin  du -sk to measure sizes, fs.rm to delete when not dryRun
 * win32   Not supported — returns unsupported message
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/clearXcodeDerivedData.ts
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
  name: "clear_xcode_derived_data",
  description:
    "Clears Xcode's DerivedData folder containing build artifacts that commonly grow " +
    "to 10-30GB. Optionally clears Xcode Archives and device support files. macOS only.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess"],
  schema: {
    what: z
      .array(z.enum(["derivedData", "archives", "deviceSupport", "all"]))
      .optional()
      .describe("What to clear. Default: ['derivedData']"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, report sizes without deleting. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ClearTarget {
  name:     string;
  path:     string;
  sizeMb:   number;
  exists:   boolean;
  cleared:  boolean;
}

interface ClearResult {
  targets:      ClearTarget[];
  totalSizeMb:  number;
  freedMb:      number;
  dryRun:       boolean;
  supported?:   boolean;
  message?:     string;
}

// -- Size helper --------------------------------------------------------------

async function getDirSizeMb(dirPath: string): Promise<number> {
  try {
    const safePath = dirPath.replace(/'/g, `'\\''`);
    const { stdout } = await execAsync(
      `du -sk '${safePath}' 2>/dev/null`,
      { maxBuffer: 2 * 1024 * 1024, shell: "/bin/bash" },
    );
    const kb = parseInt(stdout.trim().split("\t")[0], 10);
    return isNaN(kb) ? 0 : Math.round((kb / 1024) * 10) / 10;
  } catch {
    return 0;
  }
}

// -- darwin: resolve target paths ---------------------------------------------

function resolveDarwinTargets(what: string[]): Array<{ name: string; path: string }> {
  const home     = os.homedir();
  const xcodeDir = nodePath.join(home, "Library", "Developer", "Xcode");

  const allTargets: Array<{ name: string; path: string }> = [
    {
      name: "derivedData",
      path: nodePath.join(xcodeDir, "DerivedData"),
    },
    {
      name: "archives",
      path: nodePath.join(xcodeDir, "Archives"),
    },
    {
      name: "iOS DeviceSupport",
      path: nodePath.join(xcodeDir, "iOS DeviceSupport"),
    },
    {
      name: "watchOS DeviceSupport",
      path: nodePath.join(xcodeDir, "watchOS DeviceSupport"),
    },
    {
      name: "tvOS DeviceSupport",
      path: nodePath.join(xcodeDir, "tvOS DeviceSupport"),
    },
    {
      name: "visionOS DeviceSupport",
      path: nodePath.join(xcodeDir, "visionOS DeviceSupport"),
    },
  ];

  const includeAll        = what.includes("all");
  const includeDevSupport = includeAll || what.includes("deviceSupport");

  return allTargets.filter((t) => {
    if (includeAll) return true;
    if (t.name === "derivedData" && what.includes("derivedData")) return true;
    if (t.name === "archives"    && what.includes("archives"))    return true;
    if (t.name.includes("DeviceSupport") && includeDevSupport)   return true;
    return false;
  });
}

// -- darwin implementation ----------------------------------------------------

async function clearXcodeDarwin(
  what:   string[],
  dryRun: boolean,
): Promise<ClearResult> {
  const targetDefs = resolveDarwinTargets(what);
  const targets:    ClearTarget[] = [];

  for (const def of targetDefs) {
    let exists  = false;
    let sizeMb  = 0;
    let cleared = false;

    try {
      await fs.access(def.path);
      exists = true;
      sizeMb = await getDirSizeMb(def.path);
    } catch {
      exists = false;
    }

    if (!dryRun && exists) {
      try {
        await fs.rm(def.path, { recursive: true, force: true });
        cleared = true;
      } catch {
        cleared = false;
      }
    }

    targets.push({ name: def.name, path: def.path, sizeMb, exists, cleared });
  }

  const totalSizeMb = targets.reduce((sum, t) => sum + t.sizeMb, 0);
  const freedMb     = dryRun ? 0 : targets.filter((t) => t.cleared).reduce((sum, t) => sum + t.sizeMb, 0);

  return {
    targets,
    totalSizeMb: Math.round(totalSizeMb * 10) / 10,
    freedMb:     Math.round(freedMb * 10) / 10,
    dryRun,
  };
}

// -- win32 implementation -----------------------------------------------------

function clearXcodeWin32(): ClearResult {
  return {
    targets:     [],
    totalSizeMb: 0,
    freedMb:     0,
    dryRun:      true,
    supported:   false,
    message:     "Xcode is macOS only. This skill has no effect on Windows.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  what   = ["derivedData"],
  dryRun = true,
}: {
  what?:   Array<"derivedData" | "archives" | "deviceSupport" | "all">;
  dryRun?: boolean;
} = {}) {
  const platform = os.platform();
  if (platform === "win32") return clearXcodeWin32();
  return clearXcodeDarwin(what, dryRun);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ what: ["derivedData"], dryRun: true })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
