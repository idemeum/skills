/**
 * c_jamf_get_failed_commands
 *
 * Diagnostic cloud-proxy tool: lists failed mdm commands sent to a managed computer, so a configuration or enrollment fault can be diagnosed. read-only — does not issue any new commands via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/api/eoc/jamf/devices/{serial}/failed-commands
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_jamf_get_failed_commands",
  description:
    "Lists failed MDM commands sent to a managed computer, so a configuration or enrollment fault can be diagnosed. Read-only — does not issue any new commands via the cloud gateway.",
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
    "commands",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface CommandsEntry {
  uuid: string;
  commandType: string;
  commandState: string;
  commandError: string | null;
  dateSent: string | null;
  dateCompleted: string | null;
}
interface JamfGetFailedCommandsData {
  commands: CommandsEntry[];
}

export interface JamfGetFailedCommandsResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  commands?: CommandsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { deviceSerial?: string }): Promise<JamfGetFailedCommandsResult> {
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
  const r = await cloudGatewayCall<JamfGetFailedCommandsData>({
    path: `/jamf/devices/${serial}/failed-commands`,
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
    message: (Array.isArray(d.commands) ? d.commands.length : 0) + " failed MDM command(s) found.",
    commands: d.commands,
  };
}
