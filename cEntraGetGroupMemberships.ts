/**
 * c_entra_get_group_memberships
 *
 * Diagnostic cloud-proxy tool: lists the entra security and microsoft 365 groups a user directly belongs to. returns group id and display name via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/groups
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_group_memberships",
  description:
    "Lists the Entra security and Microsoft 365 groups a user directly belongs to. Returns group ID and display name via the cloud gateway.",
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
    "groups",
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

interface GroupsEntry {
  id: string;
  displayName: string;
}
interface EntraGetGroupMembershipsData {
  groups: GroupsEntry[];
}

export interface EntraGetGroupMembershipsResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  groups?: GroupsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetGroupMembershipsResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraGetGroupMembershipsData>({
    path: `/entra/users/${upn}/groups`,
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
    message: (Array.isArray(d.groups) ? d.groups.length : 0) + " group(s) found.",
    groups: d.groups,
  };
}
