/**
 * mcp/skills/getDiskUsage.ts — get_disk_usage skill
 *
 * Reports volume-level disk usage as a flat top-level object suitable
 * for the proactive evaluator's restricted DSL.  Existing
 * `disk_scan` enumerates files but does not surface a `usagePercent`
 * scalar — Wave 2 Track B Trigger 1 (`disk-nearly-full`) needs that
 * scalar at the top level so the condition `"usagePercent >= 90"`
 * parses against `meta.outputKeys`.
 *
 * Platform strategy
 * -----------------
 * darwin  `df -k <path>` → 1024-byte blocks, parse "Used" + "1024-blocks"
 *         columns.  Default path is `/` — the system root volume,
 *         which is what users mean when they say "my disk is full".
 * win32   PowerShell `Get-PSDrive -Name C` (or specified drive) →
 *         `Used` + `Free` properties in bytes.  Default drive is
 *         the system drive (`%SystemDrive%` env var, falls back to
 *         "C").
 *
 * Telemetry contract (Track B Phase 4)
 * ------------------------------------
 * `meta.outputKeys` includes: platform, usagePercent, freeGb, totalGb,
 * volume.  The DSL evaluator references `usagePercent` for the
 * disk-nearly-full rule.
 *
 * Read-only.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  runPS,
  isDarwin,
  isWin32,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_disk_usage",
  description:
    "Reports the system root volume's used vs total bytes as a top-level " +
    "scalar — `usagePercent` (0-100) plus `freeGb` / `totalGb`. Faster + " +
    "lighter than `disk_scan` (which enumerates files); designed for the " +
    "proactive disk-nearly-full trigger that fires when usagePercent ≥ 90. " +
    "Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  outputKeys: [
    "platform",
    "usagePercent",
    "freeGb",
    "totalGb",
    "volume",
  ],
  schema: {
    volume: z
      .string()
      .optional()
      .describe(
        "Volume / drive to probe. macOS default '/' (system root); " +
        "Windows default %SystemDrive% (typically 'C:'). Pass an explicit " +
        "value to inspect another mounted volume.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface GetDiskUsageResult {
  platform:      NodeJS.Platform;
  /** Volume probed — `/` on darwin, `C:` on win32 by default. */
  volume:        string;
  /** 0-100, rounded to 1 decimal. */
  usagePercent:  number;
  /** Total volume size in GB, rounded to 1 decimal. */
  totalGb:       number;
  /** Free space in GB, rounded to 1 decimal. */
  freeGb:        number;
  /** Used space in GB, rounded to 1 decimal. */
  usedGb:        number;
}

// -- darwin parsing -----------------------------------------------------------

/**
 * `df -k /` output looks like:
 *
 *   Filesystem    1024-blocks      Used    Available Capacity  iused      ifree %iused  Mounted on
 *   /dev/disk3s5  971350180  823521820   140183448    86%       ...
 *
 * We parse the second numeric line.  The "Capacity" column is a
 * percent string but we recompute from used + total so it's always a
 * float (df's percent rounds to integer).
 */
function parseDarwinDfOutput(stdout: string, volume: string): GetDiskUsageResult {
  const lines = stdout.trim().split("\n");
  if (lines.length < 2) {
    throw new Error(`get_disk_usage: unexpected df output for ${volume}: ${stdout.slice(0, 200)}`);
  }
  // Split on whitespace, drop the filesystem device name (column 0)
  // and the mount-point columns (last 1+).  The first 5 numeric
  // columns are: 1024-blocks, Used, Available, Capacity, iused.
  const parts = lines[1].split(/\s+/);
  if (parts.length < 5) {
    throw new Error(`get_disk_usage: unexpected df row format: ${lines[1]}`);
  }
  const blocks1k = parseInt(parts[1], 10);
  const used1k   = parseInt(parts[2], 10);
  if (Number.isNaN(blocks1k) || Number.isNaN(used1k) || blocks1k <= 0) {
    throw new Error(`get_disk_usage: could not parse df numbers from: ${lines[1]}`);
  }

  const totalBytes = blocks1k * 1024;
  const usedBytes  = used1k   * 1024;
  const freeBytes  = totalBytes - usedBytes;

  return {
    platform:     "darwin",
    volume,
    usagePercent: round1((usedBytes / totalBytes) * 100),
    totalGb:      round1(totalBytes / 1_000_000_000),
    usedGb:       round1(usedBytes  / 1_000_000_000),
    freeGb:       round1(freeBytes  / 1_000_000_000),
  };
}

async function getDiskUsageDarwin(volume: string): Promise<GetDiskUsageResult> {
  // Quote the volume to handle paths with spaces.  Stick to portable -k
  // (1024-byte blocks); all macOS versions support it.
  const { stdout } = await execAsync(
    `df -k ${JSON.stringify(volume)} 2>/dev/null`,
    { timeout: 10_000 },
  );
  return parseDarwinDfOutput(stdout, volume);
}

// -- win32 parsing ------------------------------------------------------------

interface WinDriveInfo {
  Used:    string | number;   // PowerShell number — emitted as JSON number, but Get-PSDrive can give string
  Free:    string | number;
  Used2?:  number;            // Reserved for parsed value
}

function parseWinPSOutput(stdout: string, volume: string): GetDiskUsageResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`get_disk_usage: empty PowerShell output for ${volume}`);
  }
  let parsed: WinDriveInfo;
  try {
    parsed = JSON.parse(trimmed) as WinDriveInfo;
  } catch (err) {
    throw new Error(`get_disk_usage: could not parse PS output: ${(err as Error).message}`);
  }
  const used = typeof parsed.Used === "number" ? parsed.Used : parseInt(String(parsed.Used), 10);
  const free = typeof parsed.Free === "number" ? parsed.Free : parseInt(String(parsed.Free), 10);
  if (Number.isNaN(used) || Number.isNaN(free)) {
    throw new Error(`get_disk_usage: PS returned non-numeric Used/Free for ${volume}`);
  }
  const total = used + free;
  if (total === 0) {
    throw new Error(`get_disk_usage: total volume size is zero for ${volume}`);
  }

  return {
    platform:     "win32",
    volume,
    usagePercent: round1((used / total) * 100),
    totalGb:      round1(total / 1_000_000_000),
    usedGb:       round1(used  / 1_000_000_000),
    freeGb:       round1(free  / 1_000_000_000),
  };
}

async function getDiskUsageWin32(volume: string): Promise<GetDiskUsageResult> {
  // Get-PSDrive -Name strips the trailing colon; "C:" becomes "C".
  // Reject path separators so we can't be tricked into running an arbitrary
  // identifier.
  const drive = volume.replace(/[:\\\/]$/, "");
  if (!/^[A-Za-z]$/.test(drive)) {
    throw new Error(`get_disk_usage: invalid Windows drive letter '${volume}'`);
  }
  const script = `
$ErrorActionPreference = 'Stop'
$d = Get-PSDrive -Name ${drive}
[pscustomobject]@{ Used = $d.Used; Free = $d.Free } | ConvertTo-Json -Compress`.trim();
  const stdout = await runPS(script, { timeoutMs: 10_000 });
  return parseWinPSOutput(stdout, `${drive}:`);
}

// -- Helpers ------------------------------------------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function defaultVolume(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "/";
  if (platform === "win32") {
    const sysDrive = process.env["SystemDrive"];
    if (sysDrive && /^[A-Za-z]:?$/.test(sysDrive)) {
      return sysDrive.replace(/[:]$/, "") + ":";
    }
    return "C:";
  }
  return "/";
}

// -- Exported run function ----------------------------------------------------

export async function run({
  volume,
}: { volume?: string } = {}): Promise<GetDiskUsageResult> {
  const platform = os.platform();
  if (!isDarwin() && !isWin32()) {
    throw new Error(`get_disk_usage: unsupported platform "${platform}"`);
  }
  const target = volume ?? defaultVolume(platform);
  if (isDarwin()) return getDiskUsageDarwin(target);
  return getDiskUsageWin32(target);
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  parseDarwinDfOutput,
  parseWinPSOutput,
  defaultVolume,
  round1,
};
