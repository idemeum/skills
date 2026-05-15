/**
 * mcp/skills/getXcodeDerivedDataInfo.ts — get_xcode_derived_data_info
 *
 * Reports Xcode DerivedData / Archives / DeviceSupport directory sizes
 * without modifying anything.  Read-only counterpart to
 * `clear_xcode_derived_data`.  macOS only.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getXcodeDerivedDataInfo.ts
 *
 * NOTE: target-path resolution is duplicated from `clearXcodeDerivedData.ts`
 * — keep in sync if the Xcode directory layout changes.
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";

import { execAsync, isDarwin } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_xcode_derived_data_info",
  description:
    "Reports Xcode DerivedData / Archives / DeviceSupport directory sizes " +
    "(macOS) without modifying anything. Read-only counterpart to " +
    "clear_xcode_derived_data. Returns supported:false on non-darwin platforms.",
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

export interface XcodeTargetInfo {
  name:      string;
  path:      string;
  exists:    boolean;
  sizeBytes: number;
}

export interface GetXcodeDerivedDataInfoResult {
  platform:   NodeJS.Platform;
  supported:  boolean;
  targets:    XcodeTargetInfo[];
  totalBytes: number;
  errors?:    Array<{ scope: string; message: string }>;
}

// -- Helpers ------------------------------------------------------------------

async function getDirSizeBytes(dirPath: string): Promise<number> {
  try {
    const safePath = dirPath.replace(/'/g, `'\\''`);
    const { stdout } = await execAsync(
      `du -sk '${safePath}' 2>/dev/null`,
      { maxBuffer: 2 * 1024 * 1024, shell: "/bin/bash" },
    );
    const kb = parseInt(stdout.trim().split("\t")[0], 10);
    return isNaN(kb) ? 0 : kb * 1024;
  } catch {
    return 0;
  }
}

function resolveDarwinTargets(): Array<{ name: string; path: string }> {
  const home     = os.homedir();
  const xcodeDir = nodePath.join(home, "Library", "Developer", "Xcode");
  return [
    { name: "derivedData",            path: nodePath.join(xcodeDir, "DerivedData") },
    { name: "archives",               path: nodePath.join(xcodeDir, "Archives") },
    { name: "iOS DeviceSupport",      path: nodePath.join(xcodeDir, "iOS DeviceSupport") },
    { name: "watchOS DeviceSupport",  path: nodePath.join(xcodeDir, "watchOS DeviceSupport") },
    { name: "tvOS DeviceSupport",     path: nodePath.join(xcodeDir, "tvOS DeviceSupport") },
    { name: "visionOS DeviceSupport", path: nodePath.join(xcodeDir, "visionOS DeviceSupport") },
  ];
}

// -- darwin -------------------------------------------------------------------

async function getXcodeDerivedDataInfoDarwin(): Promise<GetXcodeDerivedDataInfoResult> {
  const defs = resolveDarwinTargets();
  const targets: XcodeTargetInfo[] = [];

  for (const def of defs) {
    let exists    = false;
    let sizeBytes = 0;
    try {
      await fs.access(def.path);
      exists = true;
      sizeBytes = await getDirSizeBytes(def.path);
    } catch { /* not present */ }
    targets.push({ name: def.name, path: def.path, exists, sizeBytes });
  }

  targets.sort((a, b) => b.sizeBytes - a.sizeBytes);
  const totalBytes = targets.reduce((s, t) => s + t.sizeBytes, 0);

  return { platform: "darwin", supported: true, targets, totalBytes };
}

// -- Exported run -------------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetXcodeDerivedDataInfoResult> {
  if (!isDarwin()) {
    return {
      platform:   os.platform(),
      supported:  false,
      targets:    [],
      totalBytes: 0,
    };
  }
  return getXcodeDerivedDataInfoDarwin();
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
