/**
 * mcp/skills/cEntraGetUserInfo.ts — c_entra_get_user_info
 *
 * Diagnostic cloud-proxy tool: fetches an Entra user's profile and
 * account status (enabled/disabled/locked, last sign-in, MFA method
 * count, group count) via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   → { displayName, userPrincipalName, accountEnabled, lockedOut,
 *       lastSignIn, mfaMethodCount, groupCount, jobTitle, department }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_user_info",
  description:
    "Fetches an Entra (Azure AD) user's profile and account status via " +
    "the cloud gateway. Returns display name, account enabled/disabled, " +
    "lockout state, last sign-in timestamp, MFA method count, and group count.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status", "message", "displayName", "userPrincipalName",
    "accountEnabled", "lockedOut", "lastSignIn", "mfaMethodCount",
    "groupCount", "jobTitle", "department", "httpStatus", "failureReason",
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

interface EntraUserData {
  displayName:       string;
  userPrincipalName: string;
  accountEnabled:    boolean;
  lockedOut:         boolean;
  lastSignIn:        string | null;
  mfaMethodCount:    number;
  groupCount:        number;
  jobTitle:          string | null;
  department:        string | null;
}

export interface EntraGetUserInfoResult {
  status:             "ok" | "failed" | "not-configured";
  message:            string;
  displayName?:       string;
  userPrincipalName?: string;
  accountEnabled?:    boolean;
  lockedOut?:         boolean;
  lastSignIn?:        string | null;
  mfaMethodCount?:    number;
  groupCount?:        number;
  jobTitle?:          string | null;
  department?:        string | null;
  httpStatus?:        number;
  failureReason?:     CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetUserInfoResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraUserData>({
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
    status:             "ok",
    message:            `Retrieved Entra profile for ${d.displayName ?? args.userPrincipalName}.`,
    displayName:        d.displayName,
    userPrincipalName:  d.userPrincipalName,
    accountEnabled:     d.accountEnabled,
    lockedOut:          d.lockedOut,
    lastSignIn:         d.lastSignIn,
    mfaMethodCount:     d.mfaMethodCount,
    groupCount:         d.groupCount,
    jobTitle:           d.jobTitle,
    department:         d.department,
  };
}
