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
      .describe("Hostname to check (e.g. 'mail.company.com', 'vpn.example.com'). Hostname ONLY — never include a port."),
    port: z
      .number()
      .optional()
      .describe("Primary TLS port to try first. Default: 443. Must be a TLS-listening port — never the VPN's own connection port (e.g. WireGuard 51821, IKEv2 500/4500), which has no TLS listener."),
    fallbackPorts: z
      .array(z.number())
      .optional()
      .describe("Additional TLS ports to try, in order, if `port` yields no cert (connection refused / handshake failure). E.g. [8443] for SSL VPNs. The result reports the port that actually returned a cert."),
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
        // No cert read — we cannot know expiry. Do NOT report isExpired:true,
        // which would misdiagnose an unreadable cert as an expired one.
        // Consumers must branch on `error` before trusting the expiry fields.
        isExpired:       false,
        isExpiringSoon:  false,
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
  fallbackPorts,
}: {
  host:           string;
  port?:          number;
  fallbackPorts?: number[];
}) {
  // Validate host — reject anything that looks like shell injection
  if (!/^[a-zA-Z0-9.\-]+$/.test(host)) {
    throw new Error(`[check_certificate_expiry] Invalid hostname: ${host}`);
  }

  // Ordered, de-duplicated list of ports to try. The primary `port` first, then
  // any `fallbackPorts` — so an SSL VPN whose cert lives on 8443 is still found
  // when 443 refuses, in a single tool call.
  const ports = [port, ...(fallbackPorts ?? [])].filter(
    (p, i, arr) => arr.indexOf(p) === i,
  );
  for (const p of ports) {
    if (p < 1 || p > 65535) {
      throw new Error(`[check_certificate_expiry] Invalid port: ${p}`);
    }
  }

  const platform = os.platform();
  let last: CertResult & { error: string } = {
    host,
    port,
    subject:         "unknown",
    issuer:          "unknown",
    validFrom:       "unknown",
    validTo:         "unknown",
    daysUntilExpiry: -1,
    isExpired:       false,
    isExpiringSoon:  false,
    error:           "No ports tried",
  };

  for (const p of ports) {
    try {
      const result = await checkCertificate(host, p);
      // First port that returns a readable cert wins. A cert-less response
      // (result.error set, e.g. "No certificate returned") falls through to the
      // next fallback port.
      if (!result.error) return { platform, ...result };
      last = { ...result, error: result.error };
    } catch (err) {
      // Connection/handshake failure on THIS port — the host was unreachable or
      // did not speak implicit TLS here. That is NOT an expired certificate;
      // surfacing isExpired:true caused a false "cert expired" diagnosis (e.g.
      // an SMTP host probed on 443). Record it and try the next fallback port.
      last = {
        host,
        port:            p,
        subject:         "unknown",
        issuer:          "unknown",
        validFrom:       "unknown",
        validTo:         "unknown",
        daysUntilExpiry: -1,
        isExpired:       false,
        isExpiringSoon:  false,
        error:           (err as Error).message,
      };
    }
  }

  // Every port failed — return the last failure. Callers branch on `error`.
  return { platform, ...last };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ host: process.argv[2] ?? "google.com" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
