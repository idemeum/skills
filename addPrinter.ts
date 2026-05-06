/**
 * mcp/skills/addPrinter.ts — add_printer skill
 *
 * Adds a network printer by IP address or hostname using IPP (recommended)
 * or other protocols.  Use after remove_printer to re-add a printer with
 * fresh configuration.
 *
 * Platform strategy
 * -----------------
 * darwin  Constructs URI and runs `lpadmin -p -E -v {uri} -m everywhere`
 *         (or -P {driverPpd} if provided)
 * win32   PowerShell Add-PrinterPort + Add-Printer
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/addPrinter.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "add_printer",
  description:
    "Adds a network printer by IP address or hostname using IPP (recommended) " +
    "or other protocols. " +
    "Use after remove_printer to re-add a printer with fresh configuration.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  false,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo lpadmin -p \"<name>\" -E -v \"ipp://<host>\" -m everywhere  # substitute display name and printer IP/hostname",
    win32:  "Add-PrinterPort -Name \"<name>_Port\" -PrinterHostAddress \"<host>\"; Add-Printer -Name \"<name>\" -PortName \"<name>_Port\" -DriverName \"Microsoft IPP Class Driver\"  # run from elevated PowerShell",
  },
  schema: {
    name: z
      .string()
      .describe("Display name for the printer"),
    host: z
      .string()
      .describe("IP address or hostname of the printer"),
    protocol: z
      .enum(["ipp", "lpd", "socket"])
      .optional()
      .describe("Protocol. Default: ipp (recommended for modern printers)"),
    driverPpd: z
      .string()
      .optional()
      .describe("Path to PPD driver file. Omit to use IPP Everywhere (auto-driver)"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AddPrinterResult {
  name:    string;
  uri:     string;
  added:   boolean;
  message: string;
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

// -- Helpers ------------------------------------------------------------------

function buildUri(host: string, protocol: "ipp" | "lpd" | "socket"): string {
  switch (protocol) {
    case "lpd":    return `lpd://${host}/`;
    case "socket": return `socket://${host}:9100`;
    default:       return `ipp://${host}/ipp/print`;
  }
}

// -- darwin implementation ----------------------------------------------------

async function addPrinterDarwin(
  name:       string,
  host:       string,
  protocol:   "ipp" | "lpd" | "socket",
  driverPpd?: string,
): Promise<AddPrinterResult> {
  const uri         = buildUri(host, protocol);
  const safeName    = name.replace(/'/g, "'\\''");
  const driverPart  = driverPpd
    ? `-P '${driverPpd.replace(/'/g, "'\\''")}'`
    : "-m everywhere";

  const cmd = `lpadmin -p '${safeName}' -E -v '${uri}' ${driverPart}`;

  let added = false;
  let errorMsg = "";
  try {
    await execAsync(cmd);
    added = true;
  } catch (err) {
    errorMsg = (err as Error).message ?? String(err);
    added    = false;
  }

  const message = added
    ? `Printer "${name}" added successfully using URI: ${uri}`
    : `Failed to add printer "${name}": ${errorMsg}. You may need administrator privileges.`;

  return { name, uri, added, message };
}

// -- win32 implementation -----------------------------------------------------

async function addPrinterWin32(
  name:       string,
  host:       string,
  protocol:   "ipp" | "lpd" | "socket",
  _driverPpd?: string,
): Promise<AddPrinterResult> {
  const uri        = buildUri(host, protocol);
  const safeName   = name.replace(/'/g, "''");
  const safeHost   = host.replace(/'/g, "''");

  const ps = `
$ErrorActionPreference = 'Stop'
# Add printer port (ignore error if already exists)
try { Add-PrinterPort -Name '${safeHost}' -PrinterHostAddress '${safeHost}' } catch {}
# Add printer
Add-Printer -Name '${safeName}' -DriverName 'Generic / Text Only' -PortName '${safeHost}'
'success'`.trim();

  let added = false;
  let errorMsg = "";
  try {
    const result = await runPS(ps);
    added = result.toLowerCase().includes("success");
  } catch (err) {
    errorMsg = (err as Error).message ?? String(err);
    added    = false;
  }

  const message = added
    ? `Printer "${name}" added successfully. URI would be: ${uri}`
    : `Failed to add printer "${name}": ${errorMsg}. Ensure you have administrator privileges and the Generic/Text Only driver is available.`;

  return { name, uri, added, message };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  name,
  host,
  protocol  = "ipp",
  driverPpd,
}: {
  name:       string;
  host:       string;
  protocol?:  "ipp" | "lpd" | "socket";
  driverPpd?: string;
}) {
  const platform = os.platform();
  return platform === "win32"
    ? addPrinterWin32(name, host, protocol, driverPpd)
    : addPrinterDarwin(name, host, protocol, driverPpd);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ name: "TestPrinter", host: "192.168.1.100" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
