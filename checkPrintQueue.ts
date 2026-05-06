/**
 * mcp/skills/checkPrintQueue.ts — check_print_queue skill
 *
 * Shows all jobs currently in the print queue.  Identifies stuck, paused,
 * or error-state jobs.  Use when prints are not completing.
 *
 * Platform strategy
 * -----------------
 * darwin  `lpstat -o [printerName]` — parses job-id, owner, size, date
 * win32   PowerShell Get-PrintJob — returns JSON via ConvertTo-Json
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkPrintQueue.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_print_queue",
  description:
    "Shows all jobs currently in the print queue. " +
    "Identifies stuck, paused, or error-state jobs. " +
    "Use when prints are not completing.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["system"],
  auditRequired:   false,
  schema: {
    printerName: z
      .string()
      .optional()
      .describe("Printer name to check. Omit to check all printers"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface PrintJob {
  id:          string;
  printer:     string;
  owner:       string;
  document:    string;
  status:      string;
  sizeKb:      number;
  submittedAt: string;
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

async function checkPrintQueueDarwin(printerName?: string): Promise<PrintJob[]> {
  const cmd = printerName
    ? `lpstat -o '${printerName.replace(/'/g, "'\\''")}'`
    : "lpstat -o";

  let stdout = "";
  try {
    ({ stdout } = await execAsync(cmd));
  } catch (err) {
    // lpstat exits non-zero when no jobs — stdout may still have data
    stdout = (err as { stdout?: string }).stdout ?? "";
  }

  const lines = stdout.trim().split("\n").filter(Boolean);

  return lines.map((line) => {
    // Format: printer-jobid owner size date
    // e.g.:  HP_LaserJet-42 john 1024 Mon Mar 23 10:00:00 2026
    const parts = line.trim().split(/\s+/);
    const jobId = parts[0] ?? "";

    // Extract printer name from jobId (everything before last dash-number)
    const printerMatch = jobId.match(/^(.+)-(\d+)$/);
    const printer      = printerMatch ? printerMatch[1] : jobId;
    const id           = printerMatch ? printerMatch[2] : jobId;

    const owner       = parts[1] ?? "unknown";
    const sizeStr     = parts[2] ?? "0";
    const sizeKb      = Math.round(parseInt(sizeStr, 10) / 1024) || 0;
    const dateStr     = parts.slice(3).join(" ");

    return {
      id,
      printer,
      owner,
      document: jobId,
      status:   "queued",
      sizeKb,
      submittedAt: dateStr,
    };
  });
}

// -- win32 implementation -----------------------------------------------------

async function checkPrintQueueWin32(printerName?: string): Promise<PrintJob[]> {
  const ps = printerName
    ? `
$ErrorActionPreference = 'SilentlyContinue'
Get-PrintJob -PrinterName '${printerName.replace(/'/g, "''")}' |
  Select-Object Id,DocumentName,UserName,JobStatus,Size,SubmittedTime |
  ConvertTo-Json -Depth 2 -Compress`.trim()
    : `
$ErrorActionPreference = 'SilentlyContinue'
$jobs = Get-Printer | ForEach-Object {
  $name = $_.Name
  Get-PrintJob -PrinterName $name -ErrorAction SilentlyContinue |
    Select-Object Id,DocumentName,UserName,JobStatus,Size,SubmittedTime,
      @{Name='PrinterName';Expression={$name}}
}
$jobs | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const items: any[] = Array.isArray(parsed) ? parsed : [parsed];
  return items.map((item) => ({
    id:          String(item.Id ?? ""),
    printer:     String(item.PrinterName ?? printerName ?? ""),
    owner:       String(item.UserName ?? "unknown"),
    document:    String(item.DocumentName ?? ""),
    status:      String(item.JobStatus ?? "unknown"),
    sizeKb:      Math.round((Number(item.Size) || 0) / 1024),
    submittedAt: item.SubmittedTime ? String(item.SubmittedTime) : "",
  }));
}

// -- Exported run function ----------------------------------------------------

export async function run({
  printerName,
}: {
  printerName?: string;
} = {}) {
  const platform = os.platform();
  const jobs     = platform === "win32"
    ? await checkPrintQueueWin32(printerName)
    : await checkPrintQueueDarwin(printerName);

  const stuckStatuses = ["error", "stuck", "paused", "blocked"];
  const stuckCount    = jobs.filter((j) =>
    stuckStatuses.some((s) => j.status.toLowerCase().includes(s)),
  ).length;

  return {
    jobs,
    stuckCount,
    total:    jobs.length,
    platform,
  };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
