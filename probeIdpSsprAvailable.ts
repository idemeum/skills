/**
 * mcp/skills/probeIdpSsprAvailable.ts — probe_idp_sspr_available
 *
 * Best-effort HTTPS probe to determine whether the tenant's self-service
 * password-reset (SSPR) endpoint is enabled.  The skill uses this to
 * choose between the primary SSPR path and the fallback idemeum-cloud
 * orchestration path.
 *
 * Detection strategy (per IDP)
 * ----------------------------
 * Okta:   GET https://<tenant>.okta.com/api/v1/authn/recovery/password
 *           with a trivial JSON probe — if SSPR is enabled the endpoint
 *           responds with 400/403 (factor challenge) rather than 404/405.
 * Entra:  GET https://login.microsoftonline.com/common/userrealm/<user>?api-version=2.1
 *           — returns tenant metadata; reachability alone is a reasonable
 *           signal since SSPR availability isn't cleanly exposed publicly.
 * Google: no reliable public probe — returns "unknown".
 *
 * Returns { available: "yes" | "no" | "unknown", evidence }.
 * Never throws.  Network errors resolve to { available: "unknown" }.
 */

import { z }           from "zod";
import { httpGet, httpPost } from "./_shared/platform";
import { isSupportedIdp, type Idp } from "./_shared/idp";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "probe_idp_sspr_available",
  description:
    "Probes the IDP's public endpoints to infer whether self-service password " +
    "reset (SSPR) is enabled for this tenant. Best-effort: Okta and Entra " +
    "return a meaningful signal; Google returns 'unknown' because no reliable " +
    "public probe exists. The parent skill uses the result to choose between " +
    "the SSPR portal path and the idemeum-cloud fallback.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    idp: z
      .enum(["okta", "entra", "google", "unknown"])
      .describe("IDP identifier from detect_identity_provider."),
    tenant: z
      .string()
      .optional()
      .describe(
        "IDP tenant slug — required for Okta (e.g. 'acme' for acme.okta.com); " +
        "optional for Entra (falls back to 'common'); ignored for Google.",
      ),
    probeUsername: z
      .string()
      .optional()
      .describe(
        "Synthetic username for the probe request (Okta + Entra). Does NOT " +
        "authenticate — the endpoint only reveals whether the SSPR surface " +
        "is live. Defaults to 'probe@example.invalid'.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface SsprProbeResult {
  idp:       Idp;
  tenant:    string | null;
  available: "yes" | "no" | "unknown";
  /** Short explanation (status code, endpoint hit, reason). */
  evidence:  string;
}

// -- Implementation -----------------------------------------------------------

async function probeOkta(tenant: string, username: string): Promise<SsprProbeResult> {
  if (!/^[a-z0-9-]+$/i.test(tenant)) {
    return {
      idp: "okta", tenant, available: "unknown",
      evidence: `Tenant slug "${tenant}" contains invalid characters — skipping probe.`,
    };
  }
  const url = `https://${tenant.toLowerCase()}.okta.com/api/v1/authn/recovery/password`;
  const body = JSON.stringify({
    username,
    factorType: "EMAIL",
  });
  const r = await httpPost(url, body, {
    "content-type": "application/json",
    "accept":       "application/json",
  }, { timeoutMs: 5_000 });

  if (r.failureReason) {
    const isTimeout = r.failureReason === "connect_timeout" || r.failureReason === "response_timeout";
    return {
      idp: "okta", tenant, available: "unknown",
      evidence: `Okta probe ${isTimeout ? "timed out" : "network error"} for ${url}`,
    };
  }

  // 200/400/403/429 — endpoint is live (SSPR likely enabled).
  // 401 — endpoint live but auth required; treat as "yes".
  // 404/405/501 — SSPR surface not present for this tenant.
  // 0 (network error) already handled above.
  if ([200, 400, 401, 403, 429].includes(r.statusCode)) {
    return {
      idp: "okta", tenant, available: "yes",
      evidence: `Okta SSPR endpoint responded ${r.statusCode} (live)`,
    };
  }
  if ([404, 405, 501].includes(r.statusCode)) {
    return {
      idp: "okta", tenant, available: "no",
      evidence: `Okta SSPR endpoint returned ${r.statusCode} — recovery API not enabled`,
    };
  }
  return {
    idp: "okta", tenant, available: "unknown",
    evidence: `Okta SSPR endpoint returned unexpected status ${r.statusCode}`,
  };
}

async function probeEntra(tenant: string | null, username: string): Promise<SsprProbeResult> {
  const tenantSeg = tenant && tenant.length > 0 ? tenant : "common";
  const url =
    `https://login.microsoftonline.com/${encodeURIComponent(tenantSeg)}` +
    `/userrealm/${encodeURIComponent(username)}?api-version=2.1`;
  const r = await httpGet(url, { accept: "application/json" }, { timeoutMs: 5_000 });

  if (r.failureReason) {
    const isTimeout = r.failureReason === "connect_timeout" || r.failureReason === "response_timeout";
    return {
      idp: "entra", tenant, available: "unknown",
      evidence: `Entra userrealm probe ${isTimeout ? "timed out" : "network error"}`,
    };
  }

  // 200 → userrealm returned metadata, tenant reachable → SSPR typically available.
  // 400/404 → tenant unknown or invalid → SSPR not available for this tenant.
  if (r.statusCode === 200) {
    return {
      idp: "entra", tenant, available: "yes",
      evidence: `Entra userrealm endpoint responded 200 for tenant "${tenantSeg}"`,
    };
  }
  if (r.statusCode === 400 || r.statusCode === 404) {
    return {
      idp: "entra", tenant, available: "no",
      evidence: `Entra userrealm endpoint returned ${r.statusCode} — tenant not reachable`,
    };
  }
  return {
    idp: "entra", tenant, available: "unknown",
    evidence: `Entra userrealm endpoint returned unexpected status ${r.statusCode}`,
  };
}

function probeGoogle(): SsprProbeResult {
  return {
    idp: "google", tenant: null, available: "unknown",
    evidence: "Google Workspace has no reliable public SSPR probe; present both paths to the user.",
  };
}

// Exported for unit tests.
export const __testing = { probeOkta, probeEntra, probeGoogle };

// -- Exported run function ----------------------------------------------------

export async function run({
  idp,
  tenant,
  probeUsername = "probe@example.invalid",
}: {
  idp:            Idp;
  tenant?:        string;
  probeUsername?: string;
}): Promise<SsprProbeResult> {
  if (idp === "unknown") {
    return {
      idp: "unknown", tenant: null, available: "unknown",
      evidence: "IDP is unknown — cannot probe SSPR availability.",
    };
  }
  if (!isSupportedIdp(idp)) {
    return {
      idp, tenant: tenant ?? null, available: "unknown",
      evidence: `IDP "${idp}" is not supported in Wave 1 alpha — present both paths to the user.`,
    };
  }

  switch (idp) {
    case "okta":
      if (!tenant) {
        return {
          idp: "okta", tenant: null, available: "unknown",
          evidence: "Okta probe requires a tenant slug; none supplied.",
        };
      }
      return probeOkta(tenant, probeUsername);
    case "entra":
      return probeEntra(tenant ?? null, probeUsername);
    case "google":
      return probeGoogle();
  }
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "okta", tenant: "acme" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
