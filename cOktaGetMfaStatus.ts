/**
 * c_okta_get_mfa_status
 *
 * Diagnostic cloud-proxy tool: fetches an okta user's authenticator enrollments. returns the registered authenticator types (e.g. phone, security question, okta verify), their status, and enrollment timestamps via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/api/eoc/okta/users/{upn}/mfa
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_okta_get_mfa_status",
  description:
    "Fetches an Okta user's authenticator enrollments. Returns the registered authenticator types (e.g. phone, security question, Okta Verify), their status, and enrollment timestamps via the cloud gateway.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "enrollments",
    "registrationComplete",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface EnrollmentsEntry {
  id: string;
  type: string;
  status: string;
  created: string;
}
interface OktaGetMfaStatusData {
  registrationComplete: boolean;
  enrollments: EnrollmentsEntry[];
}

export interface OktaGetMfaStatusResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  registrationComplete?: boolean;
  enrollments?: EnrollmentsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<OktaGetMfaStatusResult> {
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const r = await cloudGatewayCall<OktaGetMfaStatusData>({
    path: `/okta/users/${upn}/mfa`,
    userSessionHandle: ctx?.userSessionHandle,
  });

  if (r.status !== "ok") {
    return {
      status:        r.status,
      message:       r.message,
      httpStatus:    r.httpStatus,
      failureReason: r.failureReason,
    };
  }

  const d = r.data!;
  return {
    status:  "ok",
    message: (Array.isArray(d.enrollments) ? d.enrollments.length : 0) + " MFA enrollment(s) found.",
    registrationComplete: d.registrationComplete,
    enrollments: d.enrollments,
  };
}
