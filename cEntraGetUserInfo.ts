/**
 * c_entra_get_user_info
 *
 * Diagnostic cloud-proxy tool: fetches an entra (azure ad) user's profile and account status. returns display name, account enabled/disabled, lockout state, last sign-in timestamp, job title, and department via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_user_info",
  description:
    "Fetches an Entra (Azure AD) user's profile and account status. Returns display name, account enabled/disabled, lockout state, last sign-in timestamp, job title, and department via the cloud gateway.",
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
    "displayName",
    "userPrincipalName",
    "accountEnabled",
    "lastSignIn",
    "jobTitle",
    "department",
    "lockedOut",
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

interface EntraGetUserInfoData {
  displayName: string;
  userPrincipalName: string;
  accountEnabled: boolean;
  lastSignIn: string | null;
  jobTitle: string | null;
  department: string | null;
  lockedOut: boolean;
}

export interface EntraGetUserInfoResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  displayName?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
  lastSignIn?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  lockedOut?: boolean;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetUserInfoResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraGetUserInfoData>({
    path: `/entra/users/${upn}`,
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
    message: "Retrieved Entra profile for " + (d.displayName ?? "") + ".",
    displayName: d.displayName,
    userPrincipalName: d.userPrincipalName,
    accountEnabled: d.accountEnabled,
    lastSignIn: d.lastSignIn,
    jobTitle: d.jobTitle,
    department: d.department,
    lockedOut: d.lockedOut,
  };
}
