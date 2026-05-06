/**
 * mcp/skills/listPrinters.ts — list_printers skill
 *
 * Lists all configured printers with their status, type (local/network), and
 * current queue depth. Use at the start of any printer troubleshooting workflow.
 *
 * Platform strategy
 * -----------------
 * darwin  `lpstat -p -d` for printer list and default printer,
 *         `lpstat -a` for acceptance status
 * win32   PowerShell Get-Printer with status and job count
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/listPrinters.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_printers",
  description:
    "Lists all configured printers with their status, type (local/network), and " +
    "current queue depth. Use at the start of any printer troubleshooting workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

interface PrinterEntry {
  name:       string;
  status:     string;
  isDefault:  boolean;
  type:       string;
  location:   string | null;
  queueDepth: number;
}

interface ListPrintersResult {
  printers:       PrinterEntry[];
  defaultPrinter: string | null;
  total:          number;
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

async function listPrintersDarwin(): Promise<ListPrintersResult> {
  // Get printer status lines
  let lpstatOut = "";
  try {
    ({ stdout: lpstatOut } = await execAsync("lpstat -p -d 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch (err) {
    lpstatOut = (err as { stdout?: string }).stdout ?? "";
  }

  // Get acceptance status
  let acceptOut = "";
  try {
    ({ stdout: acceptOut } = await execAsync("lpstat -a 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch { /* ignore */ }

  // Get queue depths via lpstat -o
  let queueOut = "";
  try {
    ({ stdout: queueOut } = await execAsync("lpstat -o 2>/dev/null", {
      maxBuffer: 5 * 1024 * 1024,
    }));
  } catch { /* ignore */ }

  // Parse default printer
  let defaultPrinter: string | null = null;
  const defaultMatch = lpstatOut.match(/system default destination:\s+(\S+)/);
  if (defaultMatch) defaultPrinter = defaultMatch[1];

  // Count jobs per printer
  const queueDepths: Map<string, number> = new Map();
  for (const line of queueOut.split("\n").filter(Boolean)) {
    // job lines: "PrinterName-NNN   owner  size  date"
    const jobMatch = line.match(/^([^-\s]+)-\d+\s/);
    if (jobMatch) {
      const pname = jobMatch[1];
      queueDepths.set(pname, (queueDepths.get(pname) ?? 0) + 1);
    }
  }

  // Parse lpstat -p output
  // Lines: "printer NAME is idle.  enabled since ..."
  //        "printer NAME is stopped.  Reason: ..."
  const printers: PrinterEntry[] = [];
  const printerLines = lpstatOut.split("\n").filter((l) => l.startsWith("printer "));
  for (const line of printerLines) {
    const nameMatch   = line.match(/^printer\s+(\S+)\s/);
    const statusMatch = line.match(/is\s+(idle|stopped|processing|disabled)/i);
    if (!nameMatch) continue;
    const name   = nameMatch[1];
    const status = statusMatch ? statusMatch[1] : "unknown";

    // Determine type from acceptance output (location not reliably available via lpstat)
    // We look for "IPP" or "LPD" or socket patterns in lpinfo (optional, skip if slow)
    let type     = "unknown";
    let location: string | null = null;

    // Try to get device-uri for this printer to determine type
    try {
      const { stdout: uriOut } = await execAsync(
        `lpstat -v "${name.replace(/"/g, '\\"')}" 2>/dev/null`,
        { maxBuffer: 1 * 1024 * 1024 },
      );
      if (uriOut.includes("ipp://") || uriOut.includes("ipps://")) {
        type = "network (IPP)";
      } else if (uriOut.includes("lpd://")) {
        type = "network (LPD)";
      } else if (uriOut.includes("socket://")) {
        type = "network (socket)";
      } else if (uriOut.includes("usb://")) {
        type = "local (USB)";
      } else if (uriOut.includes("file:") || uriOut.includes("pdf")) {
        type = "virtual";
      } else {
        type = "local";
      }
      const locMatch = uriOut.match(/device for [^:]+:\s+(\S+)/);
      if (locMatch) location = locMatch[1];
    } catch { /* skip */ }

    printers.push({
      name,
      status,
      isDefault:  name === defaultPrinter,
      type,
      location,
      queueDepth: queueDepths.get(name) ?? 0,
    });
  }

  return { printers, defaultPrinter, total: printers.length };
}

// -- win32 implementation -----------------------------------------------------

async function listPrintersWin32(): Promise<ListPrintersResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$printers = Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,JobCount,Location,Shared,Type
$default  = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows' -Name 'Device' -ErrorAction SilentlyContinue).Device
[PSCustomObject]@{
  printers = $printers | ConvertTo-Json -Depth 2 -Compress
  default  = if ($default) { ($default -split ',')[0].Trim() } else { $null }
} | ConvertTo-Json -Depth 3 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return { printers: [], defaultPrinter: null, total: 0 };

  let outer: { printers: string; default: string | null };
  try {
    outer = JSON.parse(raw);
  } catch {
    return { printers: [], defaultPrinter: null, total: 0 };
  }

  const defaultPrinter = outer.default ?? null;
  let printers: PrinterEntry[] = [];

  if (outer.printers) {
    try {
      const arr = JSON.parse(outer.printers);
      const list = Array.isArray(arr) ? arr : [arr];
      printers = (list as Record<string, unknown>[]).map((p) => ({
        name:       String(p.Name          ?? "Unknown"),
        status:     String(p.PrinterStatus ?? "Unknown"),
        isDefault:  String(p.Name) === defaultPrinter,
        type:       p.Shared ? "network (shared)" : String(p.Type ?? "local"),
        location:   p.Location ? String(p.Location) : null,
        queueDepth: typeof p.JobCount === "number" ? p.JobCount : 0,
      }));
    } catch { /* ignore */ }
  }

  return { printers, defaultPrinter, total: printers.length };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<ListPrintersResult> {
  const platform = os.platform();
  return platform === "win32"
    ? listPrintersWin32()
    : listPrintersDarwin();
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
