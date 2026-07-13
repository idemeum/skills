/**
 * mcp/skills/clearPrintQueue.ts — clear_print_queue skill
 *
 * Cancels all pending and stuck print jobs.  Use when the print queue is
 * jammed and jobs cannot be removed through normal means.
 *
 * Platform strategy
 * -----------------
 * darwin  `cancel -a` — cancels all jobs across all queues
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
  // Cancelling jobs is irreversible (queued work is lost), so destructive:true.
  // This is also what makes G4 auto-fire the dry-run preview + consent flow
  // (autoTriggerDryRun = supportsDryRun && (riskLevel>=high || destructive)).
  // Without it, the tool's dryRun:true default wins and the cancel never runs.
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo cancel -a  # clears all queues for all users",
    win32:  "Stop-Service Spooler -Force; Remove-Item C:\\Windows\\System32\\spool\\PRINTERS\\* -Force; Start-Service Spooler  # run from elevated PowerShell",
  },
  schema: {
    // No per-printer targeting: this tool always clears ALL queues. The
    // privileged helper daemon's clear_print_queue accepts exactly `{}`
    // (deny_unknown_fields), and the local dry-run preview must match the
    // helper's clear-all real run, so a `printerName` param would (a) be
    // rejected by the helper and (b) make the preview disagree with the action.
    dryRun: z
      .boolean()
      .nullable().optional()
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
  dryRun: boolean,
): Promise<ClearPrintQueueResult> {
  // Enumerate jobs across all queues.
  let lpstatOut = "";
  try {
    const { stdout } = await execAsync("lpstat -o");
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
      await execAsync("cancel -a");   // all queues, all users
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
  dryRun: boolean,
): Promise<ClearPrintQueueResult> {
  // Enumerate jobs across all printers.
  const listPs = `
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
    jobItems.map((j) => String(j.PrinterName ?? "")).filter(Boolean),
  )];

  if (!dryRun && jobItems.length > 0) {
    try {
      const cancelPs = `
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
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? clearPrintQueueWin32(dryRun)
    : clearPrintQueueDarwin(dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
