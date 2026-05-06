/**
 * mcp/skills/checkPrinterConnectivity.ts — check_printer_connectivity skill
 *
 * Tests TCP connectivity to a network printer on standard ports:
 * 9100 (raw/JetDirect), 631 (IPP), 80 (HTTP admin).
 * Use to determine if a printer issue is network-level vs driver/software level.
 *
 * Platform strategy
 * -----------------
 * darwin & win32  Pure Node.js net.createConnection() — platform independent.
 *                 For each port, attempts connection with timeout and records
 *                 success/latency.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkPrinterConnectivity.ts
 */

import * as os  from "os";
import * as net from "net";
import { z }    from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_printer_connectivity",
  description:
    "Tests TCP connectivity to a network printer on standard ports: " +
    "9100 (raw/JetDirect), 631 (IPP), 80 (HTTP admin). " +
    "Use to determine if a printer issue is network-level vs driver/software level.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    host: z
      .string()
      .describe("Printer IP address or hostname"),
    ports: z
      .array(z.number())
      .optional()
      .describe("Ports to test. Default: [9100, 631, 80]"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Timeout per port in ms. Default: 3000"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface PrinterPortResult {
  port:       number;
  service:    string;
  reachable:  boolean;
  latencyMs:  number | null;
}

// -- Helpers ------------------------------------------------------------------

function portService(port: number): string {
  switch (port) {
    case 9100: return "raw/JetDirect";
    case 631:  return "IPP";
    case 80:   return "HTTP admin";
    default:   return "unknown";
  }
}

function testPort(host: string, port: number, timeoutMs: number): Promise<PrinterPortResult> {
  return new Promise((resolve) => {
    const service   = portService(port);
    const startedAt = Date.now();
    let   resolved  = false;

    const finish = (result: PrinterPortResult) => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(result);
      }
    };

    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      const latencyMs = Date.now() - startedAt;
      finish({ port, service, reachable: true, latencyMs });
    });

    socket.on("timeout", () => {
      finish({ port, service, reachable: false, latencyMs: null });
    });

    socket.on("error", () => {
      finish({ port, service, reachable: false, latencyMs: null });
    });
  });
}

// -- Exported run function ----------------------------------------------------

export async function run({
  host,
  ports     = [9100, 631, 80],
  timeoutMs = 3000,
}: {
  host:       string;
  ports?:     number[];
  timeoutMs?: number;
}) {
  const results    = await Promise.all(ports.map((p) => testPort(host, p, timeoutMs)));
  const isReachable = results.some((r) => r.reachable);

  // Build recommendation based on which ports are open
  const ipp631 = results.find((r) => r.port === 631 && r.reachable);
  let recommendation = "";
  if (ipp631) {
    recommendation = `IPP is available. Recommended printer URI: ipp://${host}/ipp/print`;
  } else if (results.find((r) => r.port === 9100 && r.reachable)) {
    recommendation = `Raw/JetDirect is available. Recommended printer URI: socket://${host}:9100`;
  } else if (!isReachable) {
    recommendation = "Printer is not reachable on any tested port. Check network connection, IP address, and that the printer is powered on.";
  } else {
    recommendation = "Some ports are open. Check printer documentation for the correct URI.";
  }

  return {
    host,
    ports: results,
    isReachable,
    recommendation,
    platform: os.platform(),
  };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ host: "192.168.1.100" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
