/**
 * c_okta_unlock_account
 *
 * Corrective cloud-proxy tool: unlocks an okta user account that is in the locked_out status, restoring their ability to sign in via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/api/eoc/okta/users/{upn}/unlock
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_okta_unlock_account",
  description:
    "Unlocks an Okta user account that is in the LOCKED_OUT status, restoring their ability to sign in via the cloud gateway. Supports dry-run to preview the operation without executing.",
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

interface OktaUnlockAccountData {
  status:  "initiated" | "failed";
  message: string;
}

export interface OktaUnlockAccountResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  dryRun?: boolean;
}, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<OktaUnlockAccountResult> {
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
  const path = `/okta/users/${upn}/unlock`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST unlock account for ${ctx?.verifiedUpn ?? "the signed-in user"}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + "/api/eoc" + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<OktaUnlockAccountData>({
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
  };
}
