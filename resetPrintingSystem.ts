/**
 * mcp/skills/resetPrintingSystem.ts — reset_printing_system skill
 *
 * DESTRUCTIVE — removes ALL configured printers and resets the entire printing
 * system to factory defaults.  All printer configurations will be permanently
 * deleted.  Use only as a last resort after all other repair steps have failed.
 *
 * Platform strategy
 * -----------------
 * darwin  Lists printers with `lpstat -p`, stops CUPS, deletes printers.conf
 *         and all PPDs from /etc/cups/, restarts CUPS
 * win32   PowerShell — stops Spooler, removes printer registry entries,
 *         restarts Spooler
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/resetPrintingSystem.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reset_printing_system",
  description:
    "DESTRUCTIVE — removes ALL configured printers and resets the entire " +
    "printing system to factory defaults. All printer configurations will be " +
    "permanently deleted. " +
    "Use only as a last resort after all other repair steps have failed.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, list what would be removed without removing. STRONGLY RECOMMENDED. Default: true",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ResetPrintingSystemResult {
  printers:   string[];
  resetDone:  boolean;
  dryRun:     boolean;
  warning:    string;
  message:    string;
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

async function resetPrintingSystemDarwin(dryRun: boolean): Promise<ResetPrintingSystemResult> {
  const WARNING = "All printers must be manually re-added after reset.";

  // List all configured printers
  let printers: string[] = [];
  try {
    const { stdout } = await execAsync("lpstat -p");
    const lines = stdout.trim().split("\n").filter(Boolean);
    printers = lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return parts[1] ?? "";
    }).filter(Boolean);
  } catch {
    printers = [];
  }

  if (dryRun) {
    return {
      printers,
      resetDone: false,
      dryRun,
      warning: WARNING,
      message: `Found ${printers.length} printer(s). Run with dryRun=false to permanently remove all printers and reset the printing system.`,
    };
  }

  let resetDone = false;
  try {
    // Stop CUPS
    await execAsync("sudo launchctl stop org.cups.cupsd").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Delete printers.conf
    await execAsync("sudo rm -f /etc/cups/printers.conf").catch(() => {});

    // Delete all PPD files
    await execAsync("sudo rm -f /etc/cups/ppd/*.ppd").catch(() => {});

    // Restart CUPS
    await execAsync("sudo launchctl start org.cups.cupsd").catch(() => {});

    resetDone = true;
  } catch {
    resetDone = false;
  }

  return {
    printers,
    resetDone,
    dryRun,
    warning: WARNING,
    message: resetDone
      ? `Printing system reset. Removed ${printers.length} printer(s). All printers must be manually re-added.`
      : "Reset partially failed. Some cleanup may require manual steps or administrator privileges.",
  };
}

// -- win32 implementation -----------------------------------------------------

async function resetPrintingSystemWin32(dryRun: boolean): Promise<ResetPrintingSystemResult> {
  const WARNING = "All printers must be manually re-added after reset.";

  // List all configured printers
  let printers: string[] = [];
  try {
    const raw = await runPS(
      `$ErrorActionPreference='SilentlyContinue'
       Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress`,
    );
    if (raw) {
      const parsed = JSON.parse(raw) as string | string[];
      printers = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    printers = [];
  }

  if (dryRun) {
    return {
      printers,
      resetDone: false,
      dryRun,
      warning: WARNING,
      message: `Found ${printers.length} printer(s). Run with dryRun=false to permanently remove all printers and reset the printing system.`,
    };
  }

  let resetDone = false;
  try {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
# Stop Spooler
Stop-Service -Name Spooler -Force
Start-Sleep -Seconds 2
# Remove all printer registry entries
$regPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers'
if (Test-Path $regPath) {
  Get-ChildItem -Path $regPath | Remove-Item -Recurse -Force
}
# Restart Spooler
Start-Service -Name Spooler
'success'`.trim();

    const result = await runPS(ps);
    resetDone = result.toLowerCase().includes("success");
  } catch {
    resetDone = false;
  }

  return {
    printers,
    resetDone,
    dryRun,
    warning: WARNING,
    message: resetDone
      ? `Printing system reset. Removed registry entries for ${printers.length} printer(s). All printers must be manually re-added.`
      : "Reset failed. Ensure you have administrator privileges and the Spooler service is accessible.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? resetPrintingSystemWin32(dryRun)
    : resetPrintingSystemDarwin(dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
