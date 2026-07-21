/**
 * mcp/skills/cEntraUnlockAccount.ts — c_entra_unlock_account
 *
 * Corrective cloud-proxy tool: unlocks an Entra account that was locked
 * out after too many failed sign-in attempts. Clears the lockout state
 * so the user can sign in again.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/unlock
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {}
 *   → { status: "initiated" | "failed", message }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_unlock_account",
  description:
    "Unlocks an Entra account locked out due to too many failed sign-in " +
    "attempts. Clears the lockout state via the cloud gateway so the user " +
    "can sign in again. Supports dry-run to preview the operation.",
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

interface EntraUnlockData {
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
      message:  `Would POST account unlock for ${args.userPrincipalName}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraUnlockData>({
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
