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

import * as os         from "os";
import { exec }        from "child_process";
import { promisify }   from "util";
import { z }           from "zod";
import { expandTilde } from "./_shared/expandTilde";

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
  outputKeys: ["name","uri","added","message"],
  schema: {
    // Keys match the privileged helper's struct Params exactly (snake_case):
    // `printer_name`, `device_uri`, `driver_name`. G4 forwards executor params
    // verbatim to the helper (HELPER-IPC-PROTOCOL.md / HELPER-HANDLERS.md). The
    // caller supplies a COMPOSED device URI rather than host+protocol so the
    // local dry-run path and the helper's real run agree on one input shape.
    printer_name: z
      .string()
      .describe("Display name for the printer"),
    device_uri: z
      .string()
      .describe(
        "Full device URI. Compose from the printer's IP/hostname: " +
        "`ipp://<host>/ipp/print` (recommended), `lpd://<host>/`, or " +
        "`socket://<host>:9100`. Scheme must be ipp / lpd / socket.",
      ),
    driver_name: z
      .string()
      .nullable().optional()
      .describe("PPD file path or driver model. Omit for IPP Everywhere / the Microsoft IPP Class Driver (auto-driver)."),
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

/** Extract the host from a device URI (e.g. ipp://host/ipp/print → host). */
function hostFromUri(uri: string): string | null {
  return uri.match(/^[a-z]+:\/\/(?:[^@/\s]*@)?([^/:\s]+)/i)?.[1] ?? null;
}

// -- darwin implementation ----------------------------------------------------

async function addPrinterDarwin(
  name:        string,
  uri:         string,
  driverName?: string,
): Promise<AddPrinterResult> {
  const safeName    = name.replace(/'/g, "'\\''");
  const driverPart  = driverName
    ? `-P '${driverName.replace(/'/g, "'\\''")}'`
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
  name:         string,
  uri:          string,
  _driverName?: string,
): Promise<AddPrinterResult> {
  const host       = hostFromUri(uri);
  if (!host) {
    return { name, uri, added: false, message: `Could not parse a host from device URI "${uri}".` };
  }
  const safeName   = name.replace(/'/g, "''");
  const safeHost   = host.replace(/'/g, "''");
  const safePort   = `${safeName}_Port`;

  // Install driverless via the Microsoft IPP Class Driver (the Windows
  // equivalent of IPP Everywhere), matching this tool's documented command.
  // The previous 'Generic / Text Only' driver produced text-only garbage on
  // real printers. NOTE: win32 uses the IPP class driver regardless of
  // `protocol` — a legacy lpd/socket printer that needs a vendor driver must be
  // added with a specific PPD/INF by IT.
  const ps = `
$ErrorActionPreference = 'Stop'
# Add a TCP/IP port pointing at the printer (idempotent).
try { Add-PrinterPort -Name '${safePort}' -PrinterHostAddress '${safeHost}' } catch {}
Add-Printer -Name '${safeName}' -DriverName 'Microsoft IPP Class Driver' -PortName '${safePort}'
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
    : `Failed to add printer "${name}": ${errorMsg}. Ensure you have administrator privileges; the Microsoft IPP Class Driver ships with Windows 10/11.`;

  return { name, uri, added, message };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  printer_name: name,
  device_uri:   uri,
  driver_name:  driverName,
}: {
  printer_name: string;
  device_uri:   string;
  driver_name?: string;
}) {
  // Expand ~ in driver_name so the LLM can pass "~/Downloads/HP.ppd" naturally.
  // lpadmin -P treats the path literally; without expansion the call would
  // fail with "PPD file not found" on a path like "<cwd>/~/Downloads/HP.ppd".
  const resolvedDriver = expandTilde(driverName);

  const platform = os.platform();
  return platform === "win32"
    ? addPrinterWin32(name, uri, resolvedDriver)
    : addPrinterDarwin(name, uri, resolvedDriver);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ printer_name: "TestPrinter", device_uri: "ipp://192.168.1.100/ipp/print" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
