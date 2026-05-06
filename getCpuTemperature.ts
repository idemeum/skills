/**
 * mcp/skills/getCpuTemperature.ts — get_cpu_temperature skill
 *
 * Reports CPU temperature and checks for thermal throttling. High temperatures
 * (>90°C) indicate cooling issues that degrade performance.
 *
 * Platform strategy
 * -----------------
 * darwin  sudo powermetrics --samplers smc; fallback osx-cpu-temp
 * win32   PowerShell MSAcpi_ThermalZoneTemperature via WMI (root/wmi namespace)
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getCpuTemperature.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_cpu_temperature",
  description:
    "Reports CPU temperature and checks for thermal throttling. High " +
    "temperatures (>90°C) indicate cooling issues that degrade performance. " +
    "macOS uses powermetrics; Windows uses WMI.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, ReturnType<typeof z.string>>,
} as const;

// -- Types --------------------------------------------------------------------

interface CpuTemperatureResult {
  cpuTempC:    number | null;
  isThrottling: boolean | null;
  message:     string;
  note:        string;
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

async function getCpuTemperatureDarwin(): Promise<CpuTemperatureResult> {
  // Attempt 1: powermetrics (requires sudo or already running as root)
  try {
    const { stdout } = await execAsync(
      "sudo powermetrics --samplers smc --sample-count 1 --sample-rate 1000 -n 1 2>/dev/null",
      { maxBuffer: 2 * 1024 * 1024, timeout: 8000 },
    );

    // Parse "CPU die temperature: 52.34 °C" or "CPU die temperature: 52.34 C"
    const match = stdout.match(/CPU die temperature:\s*([\d.]+)\s*[°]?C/i);
    if (match) {
      const cpuTempC   = Math.round(parseFloat(match[1]) * 10) / 10;
      const isThrottling = cpuTempC > 90;
      return {
        cpuTempC,
        isThrottling,
        message:     isThrottling ? `CPU is thermal throttling at ${cpuTempC}°C.` : `CPU temperature is ${cpuTempC}°C.`,
        note:        "Temperature sourced from powermetrics SMC sampler.",
      };
    }
  } catch {
    // sudo not available or powermetrics failed
  }

  // Attempt 2: osx-cpu-temp (third-party, may be installed via Homebrew)
  try {
    const { stdout } = await execAsync("osx-cpu-temp 2>/dev/null", { timeout: 4000 });
    const match = stdout.match(/([\d.]+)\s*[°]?C/i);
    if (match) {
      const cpuTempC   = Math.round(parseFloat(match[1]) * 10) / 10;
      const isThrottling = cpuTempC > 90;
      return {
        cpuTempC,
        isThrottling,
        message:     isThrottling ? `CPU is thermal throttling at ${cpuTempC}°C.` : `CPU temperature is ${cpuTempC}°C.`,
        note:        "Temperature sourced from osx-cpu-temp (Homebrew). Install with: brew install osx-cpu-temp",
      };
    }
  } catch {
    // osx-cpu-temp not installed
  }

  return {
    cpuTempC:    null,
    isThrottling: null,
    message:     "CPU temperature could not be read.",
    note:
      "Elevated access is required to read CPU temperature on macOS. " +
      "Run with sudo, or install osx-cpu-temp via Homebrew: brew install osx-cpu-temp",
  };
}

// -- win32 implementation -----------------------------------------------------

async function getCpuTemperatureWin32(): Promise<CpuTemperatureResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$zones = Get-CimInstance MSAcpi_ThermalZoneTemperature -Namespace root/wmi
if ($zones) {
  $temps = $zones | ForEach-Object {
    [Math]::Round(($_.CurrentTemperature / 10.0) - 273.15, 1)
  }
  $temps | ConvertTo-Json -Compress
} else {
  'null'
}`.trim();

  try {
    const raw = await runPS(ps);
    if (!raw || raw === "null") {
      return {
        cpuTempC:    null,
        isThrottling: null,
        message:     "No thermal zone data available via WMI.",
        note:        "MSAcpi_ThermalZoneTemperature requires administrator privileges on some systems.",
      };
    }

    const parsed   = JSON.parse(raw) as number | number[];
    const temps    = Array.isArray(parsed) ? parsed : [parsed];
    const cpuTempC = Math.max(...temps);  // use highest zone temp as representative
    const isThrottling = cpuTempC > 90;

    return {
      cpuTempC,
      isThrottling,
      message:  isThrottling ? `CPU is thermal throttling at ${cpuTempC}°C.` : `CPU temperature is ${cpuTempC}°C.`,
      note:     "Temperature sourced from MSAcpi_ThermalZoneTemperature (WMI root/wmi namespace). Highest zone reported.",
    };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return {
      cpuTempC:    null,
      isThrottling: null,
      message:     `Failed to read temperature: ${msg}`,
      note:        "Try running as administrator to access WMI thermal data.",
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<CpuTemperatureResult> {
  const platform = os.platform();
  if (platform === "win32") {
    return getCpuTemperatureWin32();
  }
  return getCpuTemperatureDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
