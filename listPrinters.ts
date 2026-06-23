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

import { parsePrinterStatuses } from "./_shared/lpstatStatus";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_printers",
  description:
    "Lists all configured printers with a canonical status (idle/processing/stopped/" +
    "disabled/offline/error/unknown), canonical type (network/local/virtual), the " +
    "host (IP/hostname when derivable), and current queue depth. Use at the start of " +
    "any printer troubleshooting workflow.",
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
  /** Canonical across platforms: idle | processing | stopped | disabled | offline | error | unknown */
  status:     string;
  isDefault:  boolean;
  /** Canonical across platforms: network | local | virtual | unknown */
  type:       string;
  /** IP/hostname when derivable from the device URI/port (network printers); null for USB/virtual/Bonjour. */
  host:       string | null;
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

  // Parse lpstat -p output via the shared canonical parser (handles the
  // "disabled since" / no-"is" wording that the old inline regex missed —
  // see _shared/lpstatStatus.ts). Kept in lockstep with check_print_queue.
  const printers: PrinterEntry[] = [];
  const statuses = parsePrinterStatuses(lpstatOut);
  const printerLines = lpstatOut.split("\n").filter((l) => l.startsWith("printer "));
  for (const line of printerLines) {
    const nameMatch = line.match(/^printer\s+(\S+)\s/);
    if (!nameMatch) continue;
    const name   = nameMatch[1];
    const status = statuses.get(name) ?? "unknown";

    // Resolve canonical type + the host from the device URI. The URI is read
    // but only the host (IP/hostname) is surfaced — the full URI carries printer
    // serial numbers (PII + Layer-4 entropy). For ipp/ipps/socket/lpd the host
    // is right there in the authority; Bonjour (dnssd://) resolves via mDNS so
    // the URI has no literal host (left null → Step 3 fallback prompt).
    let type = "unknown";
    let host: string | null = null;
    try {
      const { stdout: uriOut } = await execAsync(
        `lpstat -v "${name.replace(/"/g, '\\"')}" 2>/dev/null`,
        { maxBuffer: 1 * 1024 * 1024 },
      );
      if (/(?:ipps?|socket|lpd):\/\//i.test(uriOut)) {
        type = "network";
        const hm = uriOut.match(/(?:ipps?|socket|lpd):\/\/(?:[^@/\s]*@)?([^/\s:?]+)/i);
        host = hm ? hm[1] : null;
      } else if (/dnssd:\/\//i.test(uriOut)) {
        type = "network";          // Bonjour — host not literal in the URI
      } else if (/usb:\/\//i.test(uriOut)) {
        type = "local";
      } else if (/file:|\bpdf\b/i.test(uriOut)) {
        type = "virtual";
      } else {
        type = "local";
      }
    } catch { /* skip */ }

    printers.push({
      name,
      status,            // idle | stopped | processing | disabled | unknown
      isDefault:  name === defaultPrinter,
      type,
      host,
      queueDepth: queueDepths.get(name) ?? 0,
    });
  }

  return { printers, defaultPrinter, total: printers.length };
}

// -- win32 implementation -----------------------------------------------------

async function listPrintersWin32(): Promise<ListPrintersResult> {
  // Location dropped — see darwin path comment above. Type alone conveys
  // USB / network / shared which is what callers need.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$printers = Get-Printer | Select-Object Name,DriverName,PortName,PrinterStatus,JobCount,Shared,Type
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
      printers = (list as Record<string, unknown>[]).map((p) => {
        // Normalise Windows PrinterStatus into the canonical vocabulary.
        const rawStatus = String(p.PrinterStatus ?? "").toLowerCase();
        const status =
          rawStatus.includes("offline")  ? "offline"    :
          rawStatus.includes("error")    ? "error"      :
          rawStatus.includes("paused")   ? "stopped"    :
          rawStatus.includes("printing") ? "processing" :
          (rawStatus.includes("normal") || rawStatus.includes("idle")) ? "idle" :
          "unknown";

        // Windows classes TCP/IP printers as Type "Local" with an IP-bearing
        // port, so derive type + host from PortName, not Type. (USB/LPT/COM are
        // truly local; WSD and IP/hostname ports are network.)
        const port = String(p.PortName ?? "");
        let host: string | null = null;
        let type: string;
        if (/^(?:usb|lpt|com|dot4|nul|file|portprompt)/i.test(port)) {
          type = "local";
        } else if (/^wsd/i.test(port)) {
          type = "network";
        } else {
          const h = port.replace(/^IP_/i, "");
          if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h) || /^[A-Za-z][A-Za-z0-9.\-]+$/.test(h)) {
            type = "network";
            host = h;
          } else {
            type = (p.Shared || String(p.Type) === "Connection") ? "network" : "local";
          }
        }
        if (p.Shared) type = "network";

        return {
          name:       String(p.Name ?? "Unknown"),
          status,
          isDefault:  String(p.Name) === defaultPrinter,
          type,
          host,
          queueDepth: typeof p.JobCount === "number" ? p.JobCount : 0,
        };
      });
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
