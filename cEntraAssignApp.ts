/**
 * c_entra_assign_app
 *
 * Corrective cloud-proxy tool: assigns an entra user to an enterprise application (service principal), granting them access to that app via a default app role via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/apps/{servicePrincipalId}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"principalId":"{userId}","resourceId":"{{param:servicePrincipalId}}","appRoleId":"00000000-0000-0000-0000-000000000000"}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_assign_app",
  description:
    "Assigns an Entra user to an enterprise application (service principal), granting them access to that app via a default app role via the cloud gateway. Supports dry-run to preview the operation without executing.",
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
    servicePrincipalId: z.string().min(1)
      .describe("Object ID (GUID) of the target enterprise application (service principal), as returned by an app search."),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EntraAssignAppData {
  status:  "initiated" | "failed";
  message: string;
}

export interface EntraAssignAppResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  servicePrincipalId: string;
  dryRun?: boolean;
}, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraAssignAppResult> {
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
  const servicePrincipalId = encodeURIComponent(String(args.servicePrincipalId));
  const path = `/entra/users/${upn}/apps/${servicePrincipalId}`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST assign app for ${ctx?.verifiedUpn ?? "the signed-in user"}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraAssignAppData>({
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
