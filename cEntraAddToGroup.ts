/**
 * c_entra_add_to_group
 *
 * Corrective cloud-proxy tool: adds an entra user to a security or microsoft 365 group, granting them every resource that group confers. precondition: this operation must not be called for a group whose membershiprule is non-null. those groups have dynamic (rule-based) membership computed by entra; microsoft graph rejects a direct member add, so the call fails. the caller must check membershiprule from the group search first and exclude such groups from the choices offered to the user, explaining that membership is rule-driven and it must change the rule via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/entra/users/{upn}/groups/{groupId}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"@odata.id":"https://graph.microsoft.com/v1.0/directoryObjects/{userId}"}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_add_to_group",
  description:
    "Adds an Entra user to a security or Microsoft 365 group, granting them every resource that group confers. PRECONDITION: This operation MUST NOT be called for a group whose membershipRule is non-null. Those groups have dynamic (rule-based) membership computed by Entra; Microsoft Graph rejects a direct member add, so the call fails. The caller must check membershipRule from the group search first and exclude such groups from the choices offered to the user, explaining that membership is rule-driven and IT must change the rule via the cloud gateway. Supports dry-run to preview the operation without executing.",
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
    groupId: z.string().min(1)
      .describe("Object ID (GUID) of the target group, as returned by a group search."),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EntraAddToGroupData {
  status:  "initiated" | "failed";
  message: string;
}

export interface EntraAddToGroupResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  groupId: string;
  dryRun?: boolean;
}, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraAddToGroupResult> {
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
  const groupId = encodeURIComponent(String(args.groupId));
  const path = `/entra/users/${upn}/groups/${groupId}`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST add to group for ${ctx?.verifiedUpn ?? "the signed-in user"}.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<EntraAddToGroupData>({
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
