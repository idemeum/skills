/**
 * mcp/skills/verifySsoAuth.ts — verify_sso_auth
 *
 * Unauthenticated reachability probe against the IDP's public endpoints.
 * This tool confirms that the IDP is reachable and responding healthily
 * from the endpoint — it does NOT verify that the user's new password
 * works.  Password propagation is verified implicitly when the user
 * signs back into their apps (Outlook, VPN, Teams, …).
 *
 * Probe strategy
 * --------------
 * 1. HEAD/GET the OIDC discovery endpoint
 *    (.well-known/openid-configuration) — a 200 response proves DNS +
 *    TLS + IDP liveness.
 * 2. Optionally GET the tenant-specific userinfo endpoint with NO
 *    Authorization header — the IDP should respond with 401 (challenge),
 *    proving the endpoint is live.
 *
 * Returns a structured { reachable, checks[] } result.  Never throws.
 */

import { z } from "zod";

import { httpGet } from "./_shared/platform";
import {
  buildOidcDiscoveryUrl,
  idpDisplayName,
  type Idp,
} from "./_shared/idp";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "verify_sso_auth",
  description:
    "Verifies IDP endpoint reachability and TLS health by probing the " +
    "OIDC discovery endpoint and a token endpoint (expected 401). Does NOT " +
    "verify that the user's new password works — password propagation is " +
    "verified implicitly when the user signs back into apps. Use as the " +
    "final step in a cloud IDP password-reset workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    idp: z
      .enum(["okta", "entra", "google", "unknown"])
      .describe("IDP identifier from detect_identity_provider."),
    tenant: z
      .string()
      .optional()
      .describe("IDP tenant slug (required for Okta)."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface VerifyCheck {
  name:       string;
  url:        string;
  httpStatus: number;
  passed:     boolean;
  note:       string;
}

export interface VerifySsoResult {
  idp:       Idp;
  idpLabel:  string;
  reachable: boolean;
  checks:    VerifyCheck[];
  message:   string;
}

// -- Implementation -----------------------------------------------------------

async function probeDiscovery(url: string): Promise<VerifyCheck> {
  const r = await httpGet(url, { accept: "application/json" }, { timeoutMs: 5_000 });
  if (r.failureReason) {
    return {
      name:       "OIDC discovery",
      url,
      httpStatus: r.statusCode,
      passed:     false,
      note:
        r.failureReason === "timeout"
          ? "Discovery request timed out (IDP unreachable)."
          : "Network error contacting the IDP discovery endpoint.",
    };
  }
  const passed = r.statusCode === 200;
  return {
    name:       "OIDC discovery",
    url,
    httpStatus: r.statusCode,
    passed,
    note: passed
      ? "Discovery endpoint responded 200 — TLS and DNS are healthy."
      : `Discovery endpoint returned unexpected status ${r.statusCode}.`,
  };
}

/**
 * Hit a token / login endpoint with no credentials — the expected
 * response is 400/401/405.  Any 2xx here would indicate a weird
 * misconfiguration; 5xx suggests the IDP is unhealthy.
 */
async function probeChallenge(idp: Idp, tenant?: string): Promise<VerifyCheck | null> {
  const url = challengeUrl(idp, tenant);
  if (!url) return null;
  const r = await httpGet(url, {}, { timeoutMs: 5_000 });
  if (r.failureReason) {
    return {
      name:       "Auth-endpoint reachability",
      url,
      httpStatus: r.statusCode,
      passed:     false,
      note:
        r.failureReason === "timeout"
          ? "Auth-endpoint request timed out."
          : "Network error contacting the IDP auth endpoint.",
    };
  }
  // 400/401/403/405 → endpoint is live and rejecting the anonymous hit.
  // 200/302 → also live (many IDPs redirect unauth users to a login page).
  const live = [200, 302, 400, 401, 403, 405].includes(r.statusCode);
  return {
    name:       "Auth-endpoint reachability",
    url,
    httpStatus: r.statusCode,
    passed:     live,
    note: live
      ? `Auth endpoint responded ${r.statusCode} — endpoint is live.`
      : `Auth endpoint returned ${r.statusCode}; the IDP may be unhealthy.`,
  };
}

function challengeUrl(idp: Idp, tenant?: string): string | null {
  switch (idp) {
    case "okta":
      if (!tenant || !/^[a-z0-9-]+$/i.test(tenant)) return null;
      return `https://${tenant.toLowerCase()}.okta.com/oauth2/default/v1/authorize`;
    case "entra": {
      const t = tenant && tenant.length > 0 ? tenant : "common";
      return `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/authorize`;
    }
    case "google":
      return "https://accounts.google.com/o/oauth2/v2/auth";
    case "unknown":
      return null;
  }
}

// Exported for unit tests.
export const __testing = { probeDiscovery, probeChallenge, challengeUrl };

// -- Exported run function ----------------------------------------------------

export async function run({
  idp,
  tenant,
}: {
  idp:     Idp;
  tenant?: string;
}): Promise<VerifySsoResult> {
  const idpLabel = idpDisplayName(idp);

  if (idp === "unknown") {
    return {
      idp, idpLabel, reachable: false, checks: [],
      message: "IDP is unknown — nothing to verify.",
    };
  }

  const discoveryUrl = buildOidcDiscoveryUrl(idp, tenant);
  const checks: VerifyCheck[] = [];

  if (discoveryUrl) {
    checks.push(await probeDiscovery(discoveryUrl));
  } else {
    checks.push({
      name:       "OIDC discovery",
      url:        "",
      httpStatus: 0,
      passed:     false,
      note:       "Discovery URL could not be built (missing tenant for Okta?).",
    });
  }

  const challenge = await probeChallenge(idp, tenant);
  if (challenge) checks.push(challenge);

  const reachable = checks.every((c) => c.passed);
  const message = reachable
    ? `${idpLabel} endpoints are reachable. Sign back into your apps to confirm the password propagated.`
    : `${idpLabel} reachability checks did not all pass — review the per-check notes.`;

  return { idp, idpLabel, reachable, checks, message };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "google" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
