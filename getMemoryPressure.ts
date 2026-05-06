/**
 * mcp/skills/getMemoryPressure.ts — get_memory_pressure skill
 *
 * Reports current memory pressure level, RAM usage breakdown, and swap usage.
 * Use when diagnosing system slowness caused by memory exhaustion.
 *
 * Platform strategy
 * -----------------
 * darwin  memory_pressure + vm_stat + sysctl hw.memsize
 * win32   PowerShell Win32_OperatingSystem + Get-Counter Pages/sec
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getMemoryPressure.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_memory_pressure",
  description:
    "Reports current memory pressure level, RAM usage breakdown, and swap " +
    "usage. Use when diagnosing system slowness caused by memory exhaustion.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, ReturnType<typeof z.string>>,
} as const;

// -- Types --------------------------------------------------------------------

type PressureLevel = "normal" | "warn" | "critical";

interface MemoryPressureResult {
  totalRamMb:    number;
  usedRamMb:     number;
  freeRamMb:     number;
  swapUsedMb:    number;
  pressureLevel: PressureLevel;
  pageIns:       number;
  pageOuts:      number;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function getMemoryPressureDarwin(): Promise<MemoryPressureResult> {
  // Total RAM
  const { stdout: memSizeOut } = await execAsync("sysctl -n hw.memsize 2>/dev/null");
  const totalBytes  = parseInt(memSizeOut.trim(), 10);
  const totalRamMb  = Math.round(totalBytes / (1024 * 1024));

  // Pressure level
  let pressureLevel: PressureLevel = "normal";
  try {
    const { stdout: pressureOut } = await execAsync("memory_pressure 2>/dev/null");
    const text = pressureOut.toLowerCase();
    if (text.includes("critical")) {
      pressureLevel = "critical";
    } else if (text.includes("warn")) {
      pressureLevel = "warn";
    }
  } catch {
    // memory_pressure may not be available in all contexts
  }

  // vm_stat for page stats and free memory
  let freeRamMb  = 0;
  let swapUsedMb = 0;
  let pageIns    = 0;
  let pageOuts   = 0;

  try {
    const { stdout: vmOut } = await execAsync("vm_stat 2>/dev/null");
    const pageSize = 4096; // macOS default page size in bytes

    const parseVmStat = (label: string): number => {
      const match = vmOut.match(new RegExp(`${label}[^\\d]*(\\d+)`));
      return match ? parseInt(match[1], 10) : 0;
    };

    const freePages      = parseVmStat("Pages free");
    const speculativeP   = parseVmStat("Pages speculative");
    pageIns              = parseVmStat("Pageins");
    pageOuts             = parseVmStat("Pageouts");

    freeRamMb  = Math.round(((freePages + speculativeP) * pageSize) / (1024 * 1024));

    // Swap usage from sysctl
    try {
      const { stdout: swapOut } = await execAsync("sysctl -n vm.swapusage 2>/dev/null");
      const swapMatch = swapOut.match(/used\s*=\s*([\d.]+)M/i);
      if (swapMatch) swapUsedMb = Math.round(parseFloat(swapMatch[1]));
    } catch {
      // swap info unavailable
    }
  } catch {
    // vm_stat unavailable
    freeRamMb = Math.round(os.freemem() / (1024 * 1024));
  }

  const usedRamMb = Math.max(0, totalRamMb - freeRamMb);

  return { totalRamMb, usedRamMb, freeRamMb, swapUsedMb, pressureLevel, pageIns, pageOuts };
}

// -- win32 implementation -----------------------------------------------------

async function getMemoryPressureWin32(): Promise<MemoryPressureResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,SizeStoredInPagingFiles,FreeSpaceInPagingFiles
$pagesSec = 0
try {
  $counter = Get-Counter '\\Memory\\Pages/sec' -SampleInterval 1 -MaxSamples 1
  $pagesSec = [int]$counter.CounterSamples[0].CookedValue
} catch {}
[PSCustomObject]@{
  totalKb      = [long]$os.TotalVisibleMemorySize
  freeKb       = [long]$os.FreePhysicalMemory
  pagingTotalKb= [long]$os.SizeStoredInPagingFiles
  pagingFreeKb = [long]$os.FreeSpaceInPagingFiles
  pagesSec     = $pagesSec
} | ConvertTo-Json -Compress`.trim();

  const raw  = await runPS(ps);
  const data = JSON.parse(raw) as {
    totalKb:       number;
    freeKb:        number;
    pagingTotalKb: number;
    pagingFreeKb:  number;
    pagesSec:      number;
  };

  const totalRamMb  = Math.round(data.totalKb / 1024);
  const freeRamMb   = Math.round(data.freeKb  / 1024);
  const usedRamMb   = Math.max(0, totalRamMb - freeRamMb);
  const swapUsedMb  = Math.round((data.pagingTotalKb - data.pagingFreeKb) / 1024);

  const usedRatio   = totalRamMb > 0 ? usedRamMb / totalRamMb : 0;
  const pressureLevel: PressureLevel =
    usedRatio > 0.90 ? "critical" :
    usedRatio > 0.75 ? "warn"     : "normal";

  return {
    totalRamMb,
    usedRamMb,
    freeRamMb,
    swapUsedMb,
    pressureLevel,
    pageIns:  data.pagesSec,
    pageOuts: 0,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<MemoryPressureResult> {
  const platform = os.platform();
  if (platform === "win32") {
    return getMemoryPressureWin32();
  }
  return getMemoryPressureDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
