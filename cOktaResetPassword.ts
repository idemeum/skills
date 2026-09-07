/**
 * c_okta_reset_password
 *
 * Corrective cloud-proxy tool: generates a temporary password for an okta user and expires their current password. the gateway emails the temporary password to the user's recovery address and returns only a delivery receipt via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/api/eoc/okta/users/{upn}/password/reset
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"revokeSessions":true}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_okta_reset_password",
  description:
    "Generates a temporary password for an Okta user and expires their current password. The gateway emails the temporary password to the user's recovery address and returns only a delivery receipt via the cloud gateway. Supports dry-run to preview the operation without executing.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "deliveryMethod",
    "notificationEmail",
    "willPost",
    "endpoint",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface OktaResetPasswordData {
  status:  "initiated" | "failed";
  message: string;
  deliveryMethod?: string;
  notificationEmail?: string;
}

export interface OktaResetPasswordResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  deliveryMethod?: string;
  notificationEmail?: string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  dryRun?: boolean;
}, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<OktaResetPasswordResult> {
  const baseUrl = process.env["CLOUD_GATEWAY_URL"];
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const path = `/okta/users/${upn}/password/reset`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST reset password for ${ctx?.verifiedUpn ?? "the signed-in user"}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + "/api/eoc" + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<OktaResetPasswordData>({
    method: "POST",
    path,
    userSessionHandle: ctx?.userSessionHandle,
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
    ...(d.deliveryMethod != null && { deliveryMethod: d.deliveryMethod }),
    ...(d.notificationEmail != null && { notificationEmail: d.notificationEmail }),
  };
}
