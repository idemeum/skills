/**
 * mcp/skills/checkSmtpConnectivity.ts — check_smtp_connectivity skill
 *
 * Tests TCP connectivity to an SMTP mail server on standard ports.
 * Use when outgoing email fails or bounces to determine if the issue is
 * network connectivity vs configuration.
 *
 * Platform strategy
 * -----------------
 * darwin & win32  Pure Node.js net.createConnection() — no child_process needed.
 *                 For each port, attempts a TCP connection and reads the
 *                 SMTP greeting banner (first 256 bytes).
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkSmtpConnectivity.ts
 */

import * as os  from "os";
import * as net from "net";
import { z }    from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_smtp_connectivity",
  description:
    "Tests TCP connectivity to an SMTP mail server on standard ports. " +
    "Use when outgoing email fails or bounces to determine if the issue is " +
    "network connectivity vs configuration.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    host: z
      .string()
      .describe("SMTP server hostname (e.g. 'smtp.gmail.com', 'mail.company.com')"),
    ports: z
      .array(z.number())
      .optional()
      .describe("Ports to test. Default: [587, 465, 25]"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Connection timeout per port in ms. Default: 5000"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface SmtpPortResult {
  port:        number;
  service:     string;
  reachable:   boolean;
  latencyMs:   number | null;
  banner:      string | null;
  error:       string | null;
}

// -- Helpers ------------------------------------------------------------------

function portService(port: number): string {
  switch (port) {
    case 587:  return "submission";
    case 465:  return "smtps";
    case 25:   return "smtp";
    default:   return "unknown";
  }
}

function testPort(host: string, port: number, timeoutMs: number): Promise<SmtpPortResult> {
  return new Promise((resolve) => {
    const service   = portService(port);
    const startedAt = Date.now();
    let   banner    = "";
    let   resolved  = false;

    const finish = (result: SmtpPortResult) => {
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
      // Collect the banner — wait up to 1 second for data
      const bannerTimer = setTimeout(() => {
        finish({
          port,
          service,
          reachable:  true,
          latencyMs,
          banner:     banner.trim() || null,
          error:      null,
        });
      }, 1000);
      socket.once("data", (chunk) => {
        clearTimeout(bannerTimer);
        banner = chunk.slice(0, 256).toString("utf8").replace(/\r\n/g, " ").trim();
        finish({
          port,
          service,
          reachable:  true,
          latencyMs,
          banner:     banner || null,
          error:      null,
        });
      });
    });

    socket.on("timeout", () => {
      finish({ port, service, reachable: false, latencyMs: null, banner: null, error: "Connection timed out" });
    });

    socket.on("error", (err) => {
      finish({ port, service, reachable: false, latencyMs: null, banner: null, error: err.message });
    });
  });
}

// -- Exported run function ----------------------------------------------------

export async function run({
  host,
  ports     = [587, 465, 25],
  timeoutMs = 5000,
}: {
  host:       string;
  ports?:     number[];
  timeoutMs?: number;
}) {
  const results = await Promise.all(
    ports.map((port) => testPort(host, port, timeoutMs)),
  );
  const anyReachable = results.some((r) => r.reachable);
  return { host, results, anyReachable, platform: os.platform() };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ host: "smtp.gmail.com" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
