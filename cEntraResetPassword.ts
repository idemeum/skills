/**
 * mcp/skills/cEntraResetPassword.ts — c_entra_reset_password
 *
 * Corrective cloud-proxy tool: forces a password reset for an Entra user.
 * Generates a temporary password; the user must change it on next sign-in.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/password/reset
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {}
 *   → { status: "initiated" | "failed", temporaryPassword?, message }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_reset_password",
  description:
    "Forces a password reset for an Entra user via the cloud gateway. " +
    "Generates a temporary password that must be changed on next sign-in. " +
    "Supports dry-run to preview the operation without executing.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status", "message", "temporaryPassword", "willPost", "endpoint",
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

interface EntraResetPasswordData {
  status:             "initiated" | "failed";
  temporaryPassword?: string;
  message:            string;
}

export interface EntraResetPasswordResult {
  status:              "ok" | "failed" | "not-configured";
  message:             string;
  temporaryPassword?:  string;
  willPost?:           boolean;
  endpoint?:           string;
  httpStatus?:         number;
  failureReason?:      CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
  dryRun?: boolean;
}): Promise<EntraResetPasswordResult> {
  const baseUrl = process.env["CLOUD_GATEWAY_URL"];
  const upn = encodeURIComponent(args.userPrincipalName);
  const path = `/entra/users/${upn}/password/reset`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST password reset for ${args.userPrincipalName}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraResetPasswordData>({
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
    status:            d.status === "initiated" ? "ok" : "failed",
    message:           d.message,
    ...(d.temporaryPassword && { temporaryPassword: d.temporaryPassword }),
  };
}
