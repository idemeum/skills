/**
 * mcp/skills/listClientCertificates.ts — list_client_certificates
 *
 * Enumerates personal / machine client certificates in the endpoint's
 * certificate store.  Used by identity-auth-repair to spot expired or
 * soon-to-expire client certs that are blocking SSO / 802.1x / VPN.
 *
 * Platform strategy
 * -----------------
 * darwin  `security find-identity -v -p ssl-client` — valid client
 *         identities (certs paired with a private key).  We also issue
 *         `security find-certificate -c <CN> -p` to pull the PEM and
 *         extract NotAfter.
 * win32   PowerShell:
 *           Get-ChildItem Cert:\CurrentUser\My | Select-Object Subject, Issuer, NotAfter, Thumbprint
 *           Get-ChildItem Cert:\LocalMachine\My | …
 *
 * Output schema is normalised so the skill prose doesn't branch on OS.
 */

import { z } from "zod";

import { execAsync, isDarwin, isWin32, runPS } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_client_certificates",
  description:
    "Enumerates personal and machine client certificates stored on the " +
    "endpoint. Each entry includes subject, issuer, thumbprint, NotBefore, " +
    "and NotAfter with a computed expiry flag. Use when diagnosing SSO / " +
    "802.1x / VPN failures that are caused by expired or soon-to-expire " +
    "client certs. Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    expiryWarnDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe(
        "How many days before expiry to flag a cert as 'expiring soon'. " +
        "Defaults to 30.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface ClientCertificate {
  subject:      string;
  issuer:       string;
  /** Uppercase hex thumbprint (SHA-1); may be truncated on macOS if unavailable. */
  thumbprint:   string;
  notBefore:    string | null;
  notAfter:     string | null;
  expired:      boolean;
  expiringSoon: boolean;
  /** Where the cert lives — "CurrentUser\My", "LocalMachine\My", "login-keychain", "system-keychain". */
  store:        string;
}

export interface ListCertsResult {
  platform:    "darwin" | "win32" | "other";
  certificates: ClientCertificate[];
  summary: {
    total:    number;
    expired:  number;
    expiring: number;
    healthy:  number;
  };
  status:  "ok" | "expired" | "expiring" | "empty" | "error";
  message: string;
}

// -- darwin --------------------------------------------------------------------

async function listDarwin(warnMs: number, now: number): Promise<ClientCertificate[]> {
  const certs: ClientCertificate[] = [];

  try {
    // find-identity -v -p ssl-client lists usable client identities:
    //   1) 1A2B3C4D… "alice@example.com"
    const { stdout } = await execAsync(
      `security find-identity -v -p ssl-client 2>&1`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 5_000 },
    );
    const matches = stdout.match(/^\s+\d+\)\s+([0-9A-F]+)\s+"([^"]+)"/gm) ?? [];
    for (const line of matches) {
      const m = line.match(/^\s+\d+\)\s+([0-9A-F]+)\s+"([^"]+)"/);
      if (!m) continue;
      const thumbprint = m[1];
      const subject    = m[2];

      // Best-effort NotBefore / NotAfter via openssl parsing of the cert.
      let notBefore: string | null = null;
      let notAfter:  string | null = null;
      try {
        const pem = await execAsync(
          `security find-certificate -c ${shellQuote(subject)} -p 2>/dev/null | ` +
          `openssl x509 -noout -dates 2>/dev/null`,
          { maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
        );
        const nbMatch = pem.stdout.match(/notBefore=(.+)/);
        const naMatch = pem.stdout.match(/notAfter=(.+)/);
        if (nbMatch) notBefore = parseOpensslDate(nbMatch[1]);
        if (naMatch) notAfter  = parseOpensslDate(naMatch[1]);
      } catch {
        // openssl not available or cert not readable — leave dates null.
      }

      const naMs = notAfter ? new Date(notAfter).getTime() : NaN;
      const valid = !isNaN(naMs);
      certs.push({
        subject, issuer: "(unknown — macOS security tool does not expose issuer here)",
        thumbprint, notBefore, notAfter,
        expired:      valid ? naMs < now : false,
        expiringSoon: valid ? naMs - now < warnMs && naMs > now : false,
        store:        "login-keychain",
      });
    }
  } catch {
    // Fallthrough — security command unavailable.
  }

  return certs;
}

function parseOpensslDate(s: string): string | null {
  // openssl dates look like: "Apr 21 13:45:00 2025 GMT"
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// -- win32 --------------------------------------------------------------------

async function listWin32(warnMs: number, now: number): Promise<ClientCertificate[]> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$stores = @(
  @{ Path = 'Cert:\\CurrentUser\\My';   Name = 'CurrentUser\\My' },
  @{ Path = 'Cert:\\LocalMachine\\My';  Name = 'LocalMachine\\My' }
)
$out = @()
foreach ($s in $stores) {
  try {
    $items = Get-ChildItem -Path $s.Path
    foreach ($c in $items) {
      $out += [PSCustomObject]@{
        subject    = $c.Subject
        issuer     = $c.Issuer
        thumbprint = $c.Thumbprint
        notBefore  = $c.NotBefore.ToString('o')
        notAfter   = $c.NotAfter.ToString('o')
        store      = $s.Name
      }
    }
  } catch { }
}
$out | ConvertTo-Json -Compress -Depth 4`.trim();

  try {
    const raw = await runPS(script, { timeoutMs: 10_000 });
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map((o): ClientCertificate => {
      const r = o as Record<string, unknown>;
      const naStr = typeof r["notAfter"] === "string" ? (r["notAfter"] as string) : null;
      const nbStr = typeof r["notBefore"] === "string" ? (r["notBefore"] as string) : null;
      const naMs  = naStr ? new Date(naStr).getTime() : NaN;
      const valid = !isNaN(naMs);
      return {
        subject:    String(r["subject"] ?? ""),
        issuer:     String(r["issuer"] ?? ""),
        thumbprint: String(r["thumbprint"] ?? ""),
        notBefore:  nbStr,
        notAfter:   naStr,
        expired:      valid ? naMs < now : false,
        expiringSoon: valid ? naMs - now < warnMs && naMs > now : false,
        store:      String(r["store"] ?? ""),
      };
    });
  } catch {
    return [];
  }
}

// -- Helpers ------------------------------------------------------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Exported for unit tests.
export const __testing = { listDarwin, listWin32, parseOpensslDate };

// -- Exported run function ----------------------------------------------------

export async function run({
  expiryWarnDays = 30,
}: {
  expiryWarnDays?: number;
} = {}): Promise<ListCertsResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  if (platform === "other") {
    return {
      platform, certificates: [],
      summary: { total: 0, expired: 0, expiring: 0, healthy: 0 },
      status: "error",
      message: "Unsupported platform — certificate enumeration not available.",
    };
  }

  const warnMs = expiryWarnDays * 24 * 60 * 60 * 1_000;
  const now    = Date.now();
  const certificates = platform === "darwin"
    ? await listDarwin(warnMs, now)
    : await listWin32(warnMs, now);

  const expired  = certificates.filter((c) => c.expired).length;
  const expiring = certificates.filter((c) => c.expiringSoon).length;
  const healthy  = certificates.filter((c) => !c.expired && !c.expiringSoon).length;

  const status: ListCertsResult["status"] =
    certificates.length === 0 ? "empty"
      : expired > 0 ? "expired"
      : expiring > 0 ? "expiring"
      : "ok";

  const message =
    status === "empty"
      ? "No client certificates found in the personal / machine store(s)."
      : status === "expired"
        ? `${expired} client certificate(s) have EXPIRED.`
        : status === "expiring"
          ? `${expiring} client certificate(s) expire within ${expiryWarnDays} day(s).`
          : `${healthy} client certificate(s) are healthy.`;

  return {
    platform, certificates,
    summary: { total: certificates.length, expired, expiring, healthy },
    status, message,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
