/**
 * mcp/skills/cEntraGetSignInLogs.ts — c_entra_get_sign_in_logs
 *
 * Diagnostic cloud-proxy tool: fetches recent Entra sign-in events for a
 * user. Useful for diagnosing account lockouts (source IPs, devices,
 * error codes) and detecting brute-force patterns.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/sign-ins
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   → { events: [{ timestamp, status, location, device, errorCode }] }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_sign_in_logs",
  description:
    "Fetches recent Entra sign-in events for a user via the cloud gateway. " +
    "Returns timestamps, success/failure status, location, device info, and " +
    "error codes. Useful for diagnosing lockouts and detecting suspicious activity.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status", "message", "events", "httpStatus", "failureReason",
  ],
  schema: {
    userPrincipalName: z
      .string()
      .min(1)
      .regex(
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        "must be a UPN (e.g. alice@example.com)",
      )
      .describe("The Entra user's UPN."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface SignInEvent {
  timestamp: string;
  status:    string;
  location:  string | null;
  device:    string | null;
  errorCode: number | null;
}

interface EntraSignInData {
  events: SignInEvent[];
}

export interface EntraGetSignInLogsResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  events?:        SignInEvent[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetSignInLogsResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraSignInData>({
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
  const events = d.events ?? [];
  const failedCount = events.filter((e) => e.status === "failure").length;

  return {
    status:  "ok",
    message: events.length > 0
      ? `${events.length} recent sign-in event(s); ${failedCount} failed.`
      : "No recent sign-in events found.",
    events,
  };
}
