/**
 * c_entra_find_role
 *
 * Diagnostic cloud-proxy tool: searches assignable built-in entra directory roles by display name. returns matching role definition ids and names, used to resolve a role before assignment via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/roles/search/{name}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_find_role",
  description:
    "Searches assignable built-in Entra directory roles by display name. Returns matching role definition IDs and names, used to resolve a role before assignment via the cloud gateway.",
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
    "roles",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    name: z.string().min(1)
      .describe("Display name (or prefix) of the built-in directory role to search for."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RolesEntry {
  id: string;
  displayName: string;
}
interface EntraFindRoleData {
  roles: RolesEntry[];
}

export interface EntraFindRoleResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  roles?: RolesEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  name: string;
}): Promise<EntraFindRoleResult> {
  const name = encodeURIComponent(String(args.name));
  const r = await cloudGatewayCall<EntraFindRoleData>({
    path: `/entra/roles/search/${name}`,
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
    message: (Array.isArray(d.roles) ? d.roles.length : 0) + " role(s) matched.",
    roles: d.roles,
  };
}
