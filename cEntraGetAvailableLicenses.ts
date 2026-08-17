/**
 * c_entra_get_available_licenses
 *
 * Diagnostic cloud-proxy tool: fetches every microsoft 365 licence sku the tenant has purchased, with the number of seats bought and consumed. tenant-wide — takes no user via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/licenses
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_available_licenses",
  description:
    "Fetches every Microsoft 365 licence SKU the tenant has purchased, with the number of seats bought and consumed. Tenant-wide — takes no user via the cloud gateway.",
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
    "skus",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface SkusEntry {
  skuId: string;
  skuPartNumber: string;
  totalSeats: number;
  usedSeats: number;
}
interface EntraGetAvailableLicensesData {
  skus: SkusEntry[];
}

export interface EntraGetAvailableLicensesResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  skus?: SkusEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>): Promise<EntraGetAvailableLicensesResult> {
  const r = await cloudGatewayCall<EntraGetAvailableLicensesData>({
    path: `/entra/licenses`,
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
    message: (Array.isArray(d.skus) ? d.skus.length : 0) + " licence SKU(s) in the tenant.",
    skus: d.skus,
  };
}
