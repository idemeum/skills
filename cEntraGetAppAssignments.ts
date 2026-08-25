/**
 * c_entra_get_app_assignments
 *
 * Diagnostic cloud-proxy tool: lists the enterprise applications (service principals) a user has been assigned to, via app role assignments. returns resource display name and app role id via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/apps
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_app_assignments",
  description:
    "Lists the enterprise applications (service principals) a user has been assigned to, via app role assignments. Returns resource display name and app role ID via the cloud gateway.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "apps",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface AppsEntry {
  resourceId: string;
  displayName: string;
  appRoleId: string;
}
interface EntraGetAppAssignmentsData {
  apps: AppsEntry[];
}

export interface EntraGetAppAssignmentsResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  apps?: AppsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraGetAppAssignmentsResult> {
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const r = await cloudGatewayCall<EntraGetAppAssignmentsData>({
    path: `/entra/users/${upn}/apps`,
    userSessionHandle: ctx?.userSessionHandle,
  });

  if (r.status !== "ok") {
    return {
      status:        r.status,
      message:       r.message,
      httpStatus:    r.httpStatus,
      failureReason: r.failureReason,
    };
  }

  const d = r.data!;
  return {
    status:  "ok",
    message: (Array.isArray(d.apps) ? d.apps.length : 0) + " enterprise app assignment(s) found.",
    apps: d.apps,
  };
}
