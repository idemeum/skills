/**
 * c_intune_defender_scan
 *
 * Corrective cloud-proxy tool: triggers a microsoft defender malware scan on the managed device via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/api/eoc/intune/devices/{serial}/defender-scan
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"quickScan":true}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_intune_defender_scan",
  description:
    "Triggers a Microsoft Defender malware scan on the managed device via the cloud gateway. Supports dry-run to preview the operation without executing.",
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

interface IntuneDefenderScanData {
  status:  "initiated" | "failed";
  message: string;
}

export interface IntuneDefenderScanResult {
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
}, ctx?: { deviceSerial?: string }): Promise<IntuneDefenderScanResult> {
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
  const path = `/intune/devices/${serial}/defender-scan`;

  if (args.dryRun) {
    return {
      status:   "ok",
      message:  `Would POST defender scan.`,
      willPost: true,
      endpoint: baseUrl ? baseUrl.replace(/\/$/, "") + "/api/eoc" + path : "(CLOUD_GATEWAY_URL not set)",
    };
  }

  const r = await cloudGatewayCall<IntuneDefenderScanData>({
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
