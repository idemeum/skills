/**
 * c_entra_get_sign_in_logs
 *
 * Diagnostic cloud-proxy tool: fetches recent entra sign-in events for a user. returns timestamps, success/failure status, location, device info, and error codes. useful for diagnosing lockouts and detecting suspicious activity via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/sign-ins
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_sign_in_logs",
  description:
    "Fetches recent Entra sign-in events for a user. Returns timestamps, success/failure status, location, device info, and error codes. Useful for diagnosing lockouts and detecting suspicious activity via the cloud gateway.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "events",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface EventsEntry {
  timestamp: string;
  errorCode: number | null;
  location: string | null;
  device: string | null;
  status: string | null;
  ipAddress: string | null;
  application: string | null;
}
interface EntraGetSignInLogsData {
  events: EventsEntry[];
}

export interface EntraGetSignInLogsResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  events?: EventsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraGetSignInLogsResult> {
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const r = await cloudGatewayCall<EntraGetSignInLogsData>({
    path: `/entra/users/${upn}/sign-ins`,
    userSessionHandle: ctx?.userSessionHandle,
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
    message: (Array.isArray(d.events) ? d.events.length : 0) + " recent sign-in event(s).",
    events: d.events,
  };
}
