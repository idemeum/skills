/**
 * c_okta_get_user
 *
 * Diagnostic cloud-proxy tool: fetches an okta user's profile and account status. returns display name, login, email, status (active, locked_out, suspended, etc.), and last login/password change timestamps via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/api/eoc/okta/users/{upn}
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_okta_get_user",
  description:
    "Fetches an Okta user's profile and account status. Returns display name, login, email, status (ACTIVE, LOCKED_OUT, SUSPENDED, etc.), and last login/password change timestamps via the cloud gateway.",
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
    "id",
    "accountStatus",
    "profileLogin",
    "email",
    "firstName",
    "lastName",
    "lastLogin",
    "passwordChanged",
    "statusChanged",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface OktaGetUserData {
  id: string;
  accountStatus: string;
  profileLogin: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  lastLogin: string | null;
  passwordChanged: string | null;
  statusChanged: string | null;
}

export interface OktaGetUserResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  id?: string;
  accountStatus?: string;
  profileLogin?: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  lastLogin?: string | null;
  passwordChanged?: string | null;
  statusChanged?: string | null;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<OktaGetUserResult> {
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const r = await cloudGatewayCall<OktaGetUserData>({
    path: `/okta/users/${upn}`,
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
    message: "Retrieved Okta profile for " + (d.profileLogin ?? "") + ".",
    id: d.id,
    accountStatus: d.accountStatus,
    profileLogin: d.profileLogin,
    email: d.email,
    firstName: d.firstName,
    lastName: d.lastName,
    lastLogin: d.lastLogin,
    passwordChanged: d.passwordChanged,
    statusChanged: d.statusChanged,
  };
}
