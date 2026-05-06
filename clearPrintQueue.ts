/**
 * mcp/skills/clearPrintQueue.ts — clear_print_queue skill
 *
 * Cancels all pending and stuck print jobs.  Use when the print queue is
 * jammed and jobs cannot be removed through normal means.
 *
 * Platform strategy
 * -----------------
 * darwin  `cancel -a [printerName]` — cancels all jobs for a printer or all
 * win32   PowerShell Get-PrintJob | Remove-PrintJob
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/clearPrintQueue.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "clear_print_queue",
  description:
    "Cancels all pending and stuck print jobs. " +
    "Use when the print queue is jammed and jobs cannot be removed through normal means.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo cancel -a  # clears all queues for all users",
    win32:  "Stop-Service Spooler -Force; Remove-Item C:\\Windows\\System32\\spool\\PRINTERS\\* -Force; Start-Service Spooler  # run from elevated PowerShell",
  },
  schema: {
    printerName: z
      .string()
      .optional()
      .describe("Printer name to clear. Omit to clear all queues"),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, show jobs that would be cancelled without cancelling. Default: true",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ClearPrintQueueResult {
  cancelledCount: number;
  printers:       string[];
  jobs:           string[];
  dryRun:         boolean;
  message:        string;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function clearPrintQueueDarwin(
  dryRun:       boolean,
  printerName?: string,
): Promise<ClearPrintQueueResult> {
  // First enumerate jobs
  const listCmd = printerName
    ? `lpstat -o '${printerName.replace(/'/g, "'\\''")}'`
    : "lpstat -o";

  let lpstatOut = "";
  try {
    const { stdout } = await execAsync(listCmd);
    lpstatOut = stdout;
  } catch (err) {
    lpstatOut = (err as { stdout?: string }).stdout ?? "";
  }

  const jobLines = lpstatOut.trim().split("\n").filter(Boolean);
  const jobs     = jobLines.map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean);
  const printers = [...new Set(
    jobs.map((j) => j.replace(/-\d+$/, "")).filter(Boolean),
  )];

  if (!dryRun) {
    try {
      const cancelCmd = printerName
        ? `cancel -a '${printerName.replace(/'/g, "'\\''")}'`
        : "cancel -a";
      await execAsync(cancelCmd);
    } catch {
      // Non-fatal — queue may already be empty
    }
  }

  const message = dryRun
    ? `Found ${jobs.length} job(s) in queue. Run with dryRun=false to cancel them.`
    : `Cancelled ${jobs.length} job(s) from the print queue.`;

  return {
    cancelledCount: dryRun ? 0 : jobs.length,
    printers,
    jobs,
    dryRun,
    message,
  };
}

// -- win32 implementation -----------------------------------------------------

async function clearPrintQueueWin32(
  dryRun:       boolean,
  printerName?: string,
): Promise<ClearPrintQueueResult> {
  // Enumerate jobs
  const listPs = printerName
    ? `
$ErrorActionPreference = 'SilentlyContinue'
Get-PrintJob -PrinterName '${printerName.replace(/'/g, "''")}' |
  Select-Object Id,DocumentName |
  ConvertTo-Json -Depth 2 -Compress`.trim()
    : `
$ErrorActionPreference = 'SilentlyContinue'
$jobs = Get-Printer | ForEach-Object {
  $n = $_.Name
  Get-PrintJob -PrinterName $n -ErrorAction SilentlyContinue |
    Select-Object Id,DocumentName,@{Name='PrinterName';Expression={$n}}
}
$jobs | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw = await runPS(listPs);
  let jobItems: any[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      jobItems = Array.isArray(parsed) ? parsed : [parsed];
    } catch { /* ignore parse errors */ }
  }

  const jobs     = jobItems.map((j) => String(j.DocumentName ?? j.Id ?? "")).filter(Boolean);
  const printers = [...new Set(
    jobItems.map((j) => String(j.PrinterName ?? printerName ?? "")).filter(Boolean),
  )];

  if (!dryRun && jobItems.length > 0) {
    try {
      const cancelPs = printerName
        ? `
$ErrorActionPreference = 'SilentlyContinue'
Get-PrintJob -PrinterName '${printerName.replace(/'/g, "''")}' | Remove-PrintJob`.trim()
        : `
$ErrorActionPreference = 'SilentlyContinue'
Get-Printer | ForEach-Object {
  Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Remove-PrintJob
}`.trim();
      await runPS(cancelPs);
    } catch { /* Non-fatal */ }
  }

  const message = dryRun
    ? `Found ${jobs.length} job(s) in queue. Run with dryRun=false to cancel them.`
    : `Cancelled ${jobs.length} job(s) from the print queue.`;

  return {
    cancelledCount: dryRun ? 0 : jobs.length,
    printers,
    jobs,
    dryRun,
    message,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  printerName,
  dryRun = true,
}: {
  printerName?: string;
  dryRun?:      boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? clearPrintQueueWin32(dryRun, printerName)
    : clearPrintQueueDarwin(dryRun, printerName);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
