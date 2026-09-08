/**
 * c_jamf_force_ddm_sync
 *
 * Corrective cloud-proxy tool: forces a device to check in and re-apply its declarative device management (ddm) configuration. creates and changes no policy. covers ddm-managed declarations only — jamf exposes no per-device re-push for classic configuration profiles via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/api/eoc/jamf/devices/{serial}/ddm-sync
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_jamf_force_ddm_sync",
  description:
    "Forces a device to check in and re-apply its declarative device management (DDM) configuration. Creates and changes no policy. Covers DDM-managed declarations only — Jamf exposes no per-device re-push for classic configuration profiles via the cloud gateway. Supports dry-run to preview the operation without executing.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresDeviceSerial: true,
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
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface JamfForceDdmSyncData {
  status:  "initiated" | "failed";
  message: string;
}

export interface JamfForceDdmSyncResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  dryRun?: boolean;
}, ctx?: { deviceSerial?: string }): Promise<JamfForceDdmSyncResult> {
  const baseUrl = process.env["CLOUD_GATEWAY_URL"];
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
  const path = `/jamf/devices/${serial}/ddm-sync`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST force ddm sync.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + "/api/eoc" + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<JamfForceDdmSyncData>({
    method: "POST",
    path,
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
