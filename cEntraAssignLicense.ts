/**
 * c_entra_assign_license
 *
 * Corrective cloud-proxy tool: assigns a microsoft 365 licence sku to an entra user via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/licenses/{skuId}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"addLicenses":[{"skuId":"{{param:skuId}}","disabledPlans":[]}],"removeLicenses":[]}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_assign_license",
  description:
    "Assigns a Microsoft 365 licence SKU to an Entra user via the cloud gateway. Supports dry-run to preview the operation without executing.",
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
    skuId: z.string().min(1)
      .describe("GUID of the licence SKU to assign, as returned by the tenant licence catalogue."),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EntraAssignLicenseData {
  status:  "initiated" | "failed";
  message: string;
}

export interface EntraAssignLicenseResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  skuId: string;
  dryRun?: boolean;
}, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraAssignLicenseResult> {
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
  const skuId = encodeURIComponent(String(args.skuId));
  const path = `/entra/users/${upn}/licenses/${skuId}`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST assign license for ${ctx?.verifiedUpn ?? "the signed-in user"}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraAssignLicenseData>({
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
