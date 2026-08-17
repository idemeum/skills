/**
 * c_entra_find_group
 *
 * Diagnostic cloud-proxy tool: searches entra directory groups by display name. returns matching group ids and names, used to resolve a group before membership operations. a non-null membershiprule means the group has dynamic (rule-based) membership and cannot accept a direct member add via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/groups/search/{name}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_find_group",
  description:
    "Searches Entra directory groups by display name. Returns matching group IDs and names, used to resolve a group before membership operations. A non-null membershipRule means the group has dynamic (rule-based) membership and cannot accept a direct member add via the cloud gateway.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "groups",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    name: z.string().min(1)
      .describe("Display name (or prefix) of the group to search for."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface GroupsEntry {
  id: string;
  displayName: string;
  membershipRule: string | null;
}
interface EntraFindGroupData {
  groups: GroupsEntry[];
}

export interface EntraFindGroupResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  groups?: GroupsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  name: string;
}): Promise<EntraFindGroupResult> {
  const name = encodeURIComponent(String(args.name));
  const r = await cloudGatewayCall<EntraFindGroupData>({
    path: `/entra/groups/search/${name}`,
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
    message: (Array.isArray(d.groups) ? d.groups.length : 0) + " group(s) matched.",
    groups: d.groups,
  };
}
