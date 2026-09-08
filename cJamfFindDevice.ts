/**
 * c_jamf_find_device
 *
 * Diagnostic cloud-proxy tool: locates managed computers by hardware serial number and returns basic inventory details including name, last contact time, management id, supervision, and mdm capability. also reports matchcount, since serials are not guaranteed unique — callers should refuse anything other than exactly one match via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/api/eoc/jamf/devices/{serial}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_jamf_find_device",
  description:
    "Locates managed computers by hardware serial number and returns basic inventory details including name, last contact time, management ID, supervision, and MDM capability. Also reports matchCount, since serials are not guaranteed unique — callers should refuse anything other than exactly one match via the cloud gateway.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresDeviceSerial: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "matchCount",
    "id",
    "name",
    "lastContactTime",
    "managementId",
    "supervised",
    "mdmCapable",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface JamfFindDeviceData {
  matchCount: number;
  id: string | null;
  name: string | null;
  lastContactTime: string | null;
  managementId: string | null;
  supervised: boolean | null;
  mdmCapable: boolean | null;
}

export interface JamfFindDeviceResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  matchCount?: number;
  id?: string | null;
  name?: string | null;
  lastContactTime?: string | null;
  managementId?: string | null;
  supervised?: boolean | null;
  mdmCapable?: boolean | null;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { deviceSerial?: string }): Promise<JamfFindDeviceResult> {
  // Subject is the endpoint's own hardware serial, injected by the runtime —
  // never from args — see ToolRunContext.deviceSerial in
  // electron/agent/guards/execution.ts.
  if (!ctx?.deviceSerial) {
    return {
      status:  "failed",
      message: "No device serial resolved for this run.",
    } as never;
  }
  const serial = encodeURIComponent(ctx.deviceSerial);
  const r = await cloudGatewayCall<JamfFindDeviceData>({
    path: `/jamf/devices/${serial}`,
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
    message: "Found " + (d.matchCount ?? "") + " matching computer(s).",
    matchCount: d.matchCount,
    id: d.id,
    name: d.name,
    lastContactTime: d.lastContactTime,
    managementId: d.managementId,
    supervised: d.supervised,
    mdmCapable: d.mdmCapable,
  };
}
