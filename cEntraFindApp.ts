/**
 * c_entra_find_app
 *
 * Diagnostic cloud-proxy tool: searches entra enterprise applications (service principals) by display name. returns matching service principal ids and names, used to resolve an app before assignment operations via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/apps/search/{name}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_find_app",
  description:
    "Searches Entra enterprise applications (service principals) by display name. Returns matching service principal IDs and names, used to resolve an app before assignment operations via the cloud gateway.",
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
    "apps",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    name: z.string().min(1)
      .describe("Display name (or prefix) of the enterprise application to search for."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AppsEntry {
  id: string;
  displayName: string;
  appId: string;
}
interface EntraFindAppData {
  apps: AppsEntry[];
}

export interface EntraFindAppResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  apps?: AppsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  name: string;
}): Promise<EntraFindAppResult> {
  const name = encodeURIComponent(String(args.name));
  const r = await cloudGatewayCall<EntraFindAppData>({
    path: `/entra/apps/search/${name}`,
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
    message: (Array.isArray(d.apps) ? d.apps.length : 0) + " enterprise app(s) matched.",
    apps: d.apps,
  };
}
