/**
 * mcp/skills/checkCertificateExpiry.ts — check_certificate_expiry skill
 *
 * Checks the TLS certificate expiry date for a given hostname using Node.js
 * tls.connect() — no child_process needed.
 *
 * Platform strategy
 * -----------------
 * darwin & win32  Pure Node.js tls module — cross-platform
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkCertificateExpiry.ts google.com
 */

import * as os  from "os";
import * as tls from "tls";
import { z }    from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_certificate_expiry",
  description:
    "Checks the TLS certificate expiry date for a given hostname. " +
    "Use when diagnosing HTTPS connection failures, email server issues, or " +
    "VPN authentication problems caused by expired certificates.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.  Wave 2 Track B Trigger 2
  // (`certificate-expiring`) references `daysUntilExpiry` and `isExpired`.
  outputKeys: [
    "platform",
    "host",
    "port",
    "subject",
    "issuer",
    "validFrom",
    "validTo",
    "daysUntilExpiry",
    "isExpired",
    "isExpiringSoon",
    "error",
  ],
  schema: {
    host: z
      .string()
      .describe("Hostname to check (e.g. 'mail.company.com', 'vpn.example.com')"),
    port: z
      .number()
      .optional()
      .describe("Port number. Default: 443"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface CertResult {
  host:            string;
  port:            number;
  subject:         string;
  issuer:          string;
  validFrom:       string;
  validTo:         string;
  daysUntilExpiry: number;
  isExpired:       boolean;
  isExpiringSoon:  boolean;
  error?:          string;
}

// -- Shared implementation (darwin + win32) -----------------------------------

function tlsConnect(host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, rejectUnauthorized: false, servername: host },
      () => resolve(socket),
    );
    socket.setTimeout(10_000);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`Connection to ${host}:${port} timed out`));
    });
    socket.on("error", reject);
  });
}

function formatDN(dn: Record<string, string> | undefined): string {
  if (!dn) return "unknown";
  return Object.entries(dn)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

async function checkCertificate(host: string, port: number): Promise<CertResult> {
  const socket = await tlsConnect(host, port);
  try {
    const cert = socket.getPeerCertificate();

    if (!cert || !cert.valid_to) {
      return {
        host, port,
        subject:         "unknown",
        issuer:          "unknown",
        validFrom:       "unknown",
        validTo:         "unknown",
        daysUntilExpiry: -1,
        isExpired:       true,
        isExpiringSoon:  true,
        error:           "No certificate returned",
      };
    }

    const validTo   = new Date(cert.valid_to);
    const validFrom = new Date(cert.valid_from);
    const now       = new Date();
    const msPerDay  = 1000 * 60 * 60 * 24;
    const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / msPerDay);

    return {
      host,
      port,
      subject:         formatDN(cert.subject as unknown as Record<string, string>),
      issuer:          formatDN(cert.issuer  as unknown as Record<string, string>),
      validFrom:       validFrom.toISOString(),
      validTo:         validTo.toISOString(),
      daysUntilExpiry,
      isExpired:       daysUntilExpiry < 0,
      isExpiringSoon:  daysUntilExpiry >= 0 && daysUntilExpiry < 30,
    };
  } finally {
    socket.destroy();
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  host,
  port = 443,
}: {
  host:  string;
  port?: number;
}) {
  // Validate host — reject anything that looks like shell injection
  if (!/^[a-zA-Z0-9.\-]+$/.test(host)) {
    throw new Error(`[check_certificate_expiry] Invalid hostname: ${host}`);
  }
  if (port < 1 || port > 65535) {
    throw new Error(`[check_certificate_expiry] Invalid port: ${port}`);
  }

  const platform = os.platform();
  try {
    const result = await checkCertificate(host, port);
    return { platform, ...result };
  } catch (err) {
    return {
      platform,
      host,
      port,
      subject:         "unknown",
      issuer:          "unknown",
      validFrom:       "unknown",
      validTo:         "unknown",
      daysUntilExpiry: -1,
      isExpired:       true,
      isExpiringSoon:  true,
      error:           (err as Error).message,
    };
  }
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ host: process.argv[2] ?? "google.com" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
