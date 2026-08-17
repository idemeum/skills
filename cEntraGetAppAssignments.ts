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
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status",
    "message",
    "apps",
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
  },
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

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetAppAssignmentsResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraGetAppAssignmentsData>({
    path: `/entra/users/${upn}/apps`,
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
