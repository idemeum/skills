/**
 * c_intune_find_device
 *
 * Diagnostic cloud-proxy tool: looks up a managed device by hardware serial number. returns the managed device id, compliance state, operating system, os version, device name and last sync timestamp via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/api/eoc/intune/devices/{serial}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_intune_find_device",
  description:
    "Looks up a managed device by hardware serial number. Returns the managed device ID, compliance state, operating system, OS version, device name and last sync timestamp via the cloud gateway.",
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
    "deviceId",
    "deviceName",
    "complianceState",
    "osName",
    "osVersion",
    "lastCheckIn",
    "matchCount",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface IntuneFindDeviceData {
  deviceId: string;
  deviceName: string;
  complianceState: string;
  osName: string;
  osVersion: string;
  lastCheckIn: string;
  matchCount: number;
}

export interface IntuneFindDeviceResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  deviceId?: string;
  deviceName?: string;
  complianceState?: string;
  osName?: string;
  osVersion?: string;
  lastCheckIn?: string;
  matchCount?: number;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { deviceSerial?: string }): Promise<IntuneFindDeviceResult> {
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
  const r = await cloudGatewayCall<IntuneFindDeviceData>({
    path: `/intune/devices/${serial}`,
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
    message: "Found device " + (d.deviceName ?? "") + ".",
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    complianceState: d.complianceState,
    osName: d.osName,
    osVersion: d.osVersion,
    lastCheckIn: d.lastCheckIn,
    matchCount: d.matchCount,
  };
}
