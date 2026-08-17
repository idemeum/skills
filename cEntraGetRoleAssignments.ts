/**
 * c_entra_get_role_assignments
 *
 * Diagnostic cloud-proxy tool: lists the entra directory role assignments held by a user. returns role definition id, assignment id, and each role's display name via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/roles
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_role_assignments",
  description:
    "Lists the Entra directory role assignments held by a user. Returns role definition ID, assignment ID, and each role's display name via the cloud gateway.",
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
    "roles",
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

interface RolesEntry {
  assignmentId: string;
  roleDefinitionId: string;
  displayName: string;
}
interface EntraGetRoleAssignmentsData {
  roles: RolesEntry[];
}

export interface EntraGetRoleAssignmentsResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  roles?: RolesEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetRoleAssignmentsResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraGetRoleAssignmentsData>({
    path: `/entra/users/${upn}/roles`,
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
    message: (Array.isArray(d.roles) ? d.roles.length : 0) + " directory role assignment(s) found.",
    roles: d.roles,
  };
}
