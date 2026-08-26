/**
 * c_entra_get_user_info
 *
 * Diagnostic cloud-proxy tool: fetches an entra (azure ad) user's profile and account status. returns display name, account enabled/disabled, lockout state, last sign-in timestamp, job title, department, usagelocation (required by microsoft before a licence can be assigned to the user), and recoveryemail (the alternate address a password reset is delivered to) via the cloud gateway.
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
    "Fetches an Entra (Azure AD) user's profile and account status. Returns display name, account enabled/disabled, lockout state, last sign-in timestamp, job title, department, usageLocation (required by Microsoft before a licence can be assigned to the user), and recoveryEmail (the alternate address a password reset is delivered to) via the cloud gateway.",
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
    "displayName",
    "userPrincipalName",
    "accountEnabled",
    "lastSignIn",
    "jobTitle",
    "department",
    "usageLocation",
    "recoveryEmail",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface EntraGetUserInfoData {
  displayName: string;
  userPrincipalName: string;
  accountEnabled: boolean;
  lastSignIn: string | null;
  jobTitle: string | null;
  department: string | null;
  usageLocation: string | null;
  recoveryEmail: string | null;
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
  usageLocation?: string | null;
  recoveryEmail?: string | null;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraGetUserInfoResult> {
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const r = await cloudGatewayCall<EntraGetUserInfoData>({
    path: `/entra/users/${upn}`,
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
    message: "Retrieved Entra profile for " + (d.displayName ?? "") + ".",
    displayName: d.displayName,
    userPrincipalName: d.userPrincipalName,
    accountEnabled: d.accountEnabled,
    lastSignIn: d.lastSignIn,
    jobTitle: d.jobTitle,
    department: d.department,
    usageLocation: d.usageLocation,
    recoveryEmail: d.recoveryEmail,
  };
}
