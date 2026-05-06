/**
 * mcp/skills/removePrinter.ts — remove_printer skill
 *
 * Removes a printer from the system.  Use when a printer is stuck in
 * permanent error state or needs to be re-added with fresh configuration.
 *
 * Platform strategy
 * -----------------
 * darwin  `lpstat -p` to verify name exists; `lpadmin -x {name}` to remove
 * win32   PowerShell Get-Printer to verify; Remove-Printer to remove
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/removePrinter.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "remove_printer",
  description:
    "Removes a printer from the system. " +
    "Use when a printer is stuck in permanent error state or needs to be " +
    "re-added with fresh configuration.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo lpadmin -x \"<printerName>\"  # substitute the exact printer name from list_printers",
    win32:  "Remove-Printer -Name \"<printerName>\"  # run from elevated PowerShell",
  },
  schema: {
    printerName: z
      .string()
      .describe("Exact printer name to remove (get names from list_printers)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, verify printer exists without removing. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RemovePrinterResult {
  printerName: string;
  found:       boolean;
  removed:     boolean;
  dryRun:      boolean;
  message:     string;
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

async function removePrinterDarwin(
  printerName: string,
  dryRun:      boolean,
): Promise<RemovePrinterResult> {
  // List printers to verify the name exists
  let found = false;
  try {
    const { stdout } = await execAsync("lpstat -p");
    const lines = stdout.split("\n").filter(Boolean);
    found = lines.some((line) => {
      // lpstat -p output: "printer NAME ..."
      const parts = line.trim().split(/\s+/);
      return parts[1] === printerName;
    });
  } catch {
    found = false;
  }

  let removed = false;
  if (!dryRun && found) {
    try {
      await execAsync(`lpadmin -x '${printerName.replace(/'/g, "'\\''")}'`);
      removed = true;
    } catch {
      removed = false;
    }
  }

  const message = dryRun
    ? found
      ? `Printer "${printerName}" found. Run with dryRun=false to remove it.`
      : `Printer "${printerName}" not found. Use list_printers to see available printer names.`
    : removed
      ? `Printer "${printerName}" has been removed from the system.`
      : found
        ? `Failed to remove printer "${printerName}". You may need administrator privileges.`
        : `Printer "${printerName}" not found — nothing to remove.`;

  return { printerName, found, removed, dryRun, message };
}

// -- win32 implementation -----------------------------------------------------

async function removePrinterWin32(
  printerName: string,
  dryRun:      boolean,
): Promise<RemovePrinterResult> {
  // Verify printer exists
  let found = false;
  try {
    const raw = await runPS(
      `$ErrorActionPreference='SilentlyContinue'
       $p = Get-Printer -Name '${printerName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
       if ($p) { 'true' } else { 'false' }`,
    );
    found = raw.trim().toLowerCase() === "true";
  } catch {
    found = false;
  }

  let removed = false;
  if (!dryRun && found) {
    try {
      await runPS(
        `Remove-Printer -Name '${printerName.replace(/'/g, "''")}'`,
      );
      removed = true;
    } catch {
      removed = false;
    }
  }

  const message = dryRun
    ? found
      ? `Printer "${printerName}" found. Run with dryRun=false to remove it.`
      : `Printer "${printerName}" not found. Use list_printers to see available printer names.`
    : removed
      ? `Printer "${printerName}" has been removed from the system.`
      : found
        ? `Failed to remove printer "${printerName}". Ensure you have administrator privileges.`
        : `Printer "${printerName}" not found — nothing to remove.`;

  return { printerName, found, removed, dryRun, message };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  printerName,
  dryRun = true,
}: {
  printerName: string;
  dryRun?:     boolean;
}) {
  const platform = os.platform();
  return platform === "win32"
    ? removePrinterWin32(printerName, dryRun)
    : removePrinterDarwin(printerName, dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ printerName: "TestPrinter" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
