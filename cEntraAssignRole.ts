/**
 * c_entra_assign_role
 *
 * Corrective cloud-proxy tool: assigns an entra built-in directory role to a user, granting them the permissions associated with that role tenant-wide via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/roles/{roleDefinitionId}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"principalId":"{userId}","roleDefinitionId":"{{param:roleDefinitionId}}","directoryScopeId":"/"}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_assign_role",
  description:
    "Assigns an Entra built-in directory role to a user, granting them the permissions associated with that role tenant-wide via the cloud gateway. Supports dry-run to preview the operation without executing.",
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
    roleDefinitionId: z.string().min(1)
      .describe("GUID of the built-in directory role definition to assign, as returned by a role search."),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EntraAssignRoleData {
  status:  "initiated" | "failed";
  message: string;
}

export interface EntraAssignRoleResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  roleDefinitionId: string;
  dryRun?: boolean;
}, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraAssignRoleResult> {
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
  const roleDefinitionId = encodeURIComponent(String(args.roleDefinitionId));
  const path = `/entra/users/${upn}/roles/${roleDefinitionId}`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST assign role for ${ctx?.verifiedUpn ?? "the signed-in user"}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraAssignRoleData>({
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
