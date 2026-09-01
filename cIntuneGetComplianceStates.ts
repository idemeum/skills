/**
 * c_intune_get_compliance_states
 *
 * Diagnostic cloud-proxy tool: fetches per-policy device compliance policy states for a managed device, showing which compliance policies are applied and their status via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/api/eoc/intune/devices/{serial}/compliance-states
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_intune_get_compliance_states",
  description:
    "Fetches per-policy device compliance policy states for a managed device, showing which compliance policies are applied and their status via the cloud gateway.",
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
    "states",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface StatesEntry {
  name: string;
  platformType: string;
  state: string;
  version: number | null;
  stateReason: string | null;
}
interface IntuneGetComplianceStatesData {
  states: StatesEntry[];
}

export interface IntuneGetComplianceStatesResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  states?: StatesEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { deviceSerial?: string }): Promise<IntuneGetComplianceStatesResult> {
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
  const r = await cloudGatewayCall<IntuneGetComplianceStatesData>({
    path: `/intune/devices/${serial}/compliance-states`,
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
    message: (Array.isArray(d.states) ? d.states.length : 0) + " compliance policy state(s) retrieved.",
    states: d.states,
  };
}
