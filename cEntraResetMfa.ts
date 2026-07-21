/**
 * mcp/skills/cEntraResetMfa.ts — c_entra_reset_mfa
 *
 * Corrective cloud-proxy tool: resets all MFA methods for an Entra user,
 * forcing re-enrollment on next sign-in. Uses the cloud gateway which
 * holds Graph Application permissions (UserAuthenticationMethod.ReadWrite.All).
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/mfa/reset
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {}
 *   → { status: "initiated" | "failed", message }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_reset_mfa",
  description:
    "Resets all MFA registration methods for an Entra user via the cloud " +
    "gateway. The user will be prompted to re-enroll MFA on their next " +
    "sign-in. Supports dry-run to preview the operation without executing.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status", "message", "willPost", "endpoint",
    "httpStatus", "failureReason",
  ],
  schema: {
    userPrincipalName: z
      .string()
      .min(1)
      .regex(
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "must be a UPN (e.g. alice@example.com)",
      )
      .describe("The Entra user's UPN."),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EntraResetMfaData {
  status:  "initiated" | "failed";
  message: string;
}

export interface EntraResetMfaResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
  dryRun?: boolean;
}): Promise<EntraResetMfaResult> {
  const baseUrl = process.env["CLOUD_GATEWAY_URL"];
  const upn = encodeURIComponent(args.userPrincipalName);
  const path = `/entra/users/${upn}/mfa/reset`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST MFA reset for ${args.userPrincipalName}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraResetMfaData>({
    method: "POST",
    path,
  });

  if (r.status !== "ok") {
    return {
      status:        r.status === "not-configured" ? "not-configured" : "failed",
      message:       r.message,
      httpStatus:    r.httpStatus,
      failureReason: r.failureReason,
    };
  }

  const d = r.data!;
  return {
    status:  d.status === "initiated" ? "ok" : "failed",
    message: d.message,
  };
}
