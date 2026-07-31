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
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status",
    "message",
    "events",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    userPrincipalName: z
      .string()
      .min(1)
      .regex(
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "must be a UPN (e.g. alice@example.com)",
      )
      .describe("The Microsoft Entra ID user's UPN."),
  },
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

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetSignInLogsResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraGetSignInLogsData>({
    path: `/entra/users/${upn}/sign-ins`,
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
