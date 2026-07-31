/**
 * c_entra_unlock_account
 *
 * Corrective cloud-proxy tool: unlocks an entra account locked out due to too many failed sign-in attempts. clears the lockout state so the user can sign in again via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/unlock
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"accountEnabled":true}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_unlock_account",
  description:
    "Unlocks an Entra account locked out due to too many failed sign-in attempts. Clears the lockout state so the user can sign in again via the cloud gateway. Supports dry-run to preview the operation without executing.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status",
    "message",
    "willPost",
    "endpoint",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    userPrincipalName: z
      .string()
      .min(1)
      .regex(
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "must be a UPN (e.g. alice@example.com)",
      )
      .describe("The Microsoft Entra ID user's UPN."),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EntraUnlockAccountData {
  status:  "initiated" | "failed";
  message: string;
}

export interface EntraUnlockAccountResult {
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
}): Promise<EntraUnlockAccountResult> {
  const baseUrl = process.env["CLOUD_GATEWAY_URL"];
  const upn = encodeURIComponent(args.userPrincipalName);
  const path = `/entra/users/${upn}/unlock`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST unlock account for ${args.userPrincipalName}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraUnlockAccountData>({
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
