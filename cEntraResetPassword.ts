/**
 * c_entra_reset_password
 *
 * Corrective cloud-proxy tool: forces a password reset for an entra user. generates a temporary password that is emailed by the gateway to the user's recovery address (othermails) and is never returned to the agent. precondition: this operation must not be called when the user has no recoveryemail (i.e. othermails is empty), because the gateway would have nowhere to deliver the temporary password, leaving the user locked out with a changed credential and no way to retrieve it. the caller must first check recoveryemail from get_user_info and stop if it is null. response handling: the password reset always succeeds regardless of whether the notification email was delivered, so the caller must branch on the response's deliverymethod field and never assume delivery occurred. if deliverymethod is 'email', the temporary password was sent — tell the user to check notificationemail (including their spam/junk folder) for the message. if deliverymethod is 'none', the password was changed but could not be emailed — tell the user their password has changed and they must contact it to obtain it; do not tell them to check any inbox in this case via the cloud gateway. supports dry-run to preview the operation without executing.
 *
 * Wire contract
 * -------------
 * PATCH ${CLOUD_GATEWAY_URL}/entra/users/{upn}/password/reset
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   Body: {"passwordProfile":{"password":"{{generated:password}}","forceChangePasswordNextSignIn":true}}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_reset_password",
  description:
    "Forces a password reset for an Entra user. Generates a temporary password that is emailed by the gateway to the user's recovery address (otherMails) and is never returned to the agent. PRECONDITION: This operation MUST NOT be called when the user has no recoveryEmail (i.e. otherMails is empty), because the gateway would have nowhere to deliver the temporary password, leaving the user locked out with a changed credential and no way to retrieve it. The caller must first check recoveryEmail from get_user_info and stop if it is null. RESPONSE HANDLING: The password reset always succeeds regardless of whether the notification email was delivered, so the caller MUST branch on the response's deliveryMethod field and never assume delivery occurred. If deliveryMethod is 'email', the temporary password was sent — tell the user to check notificationEmail (including their spam/junk folder) for the message. If deliveryMethod is 'none', the password WAS changed but could NOT be emailed — tell the user their password has changed and they must contact IT to obtain it; do NOT tell them to check any inbox in this case via the cloud gateway. Supports dry-run to preview the operation without executing.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  // Deliberately false — diverges from the `kind: corrective` codegen template
  // (see scaffold-once policy in CLAUDE.md). The dry-run branch only echoed the
  // gateway URL it *would* POST to; it previewed no consequence, so it bought a
  // second confirmation card without telling the user anything the consent card
  // doesn't. The single G4 consent gate is the confirmation for this tool.
  // Matches add_printer, which ships high-risk + consent + no dry-run.
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "deliveryMethod",
    "notificationEmail",
    "httpStatus",
    "failureReason",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface EntraResetPasswordData {
  status:  "initiated" | "failed";
  message: string;
  deliveryMethod?: string;
  notificationEmail?: string;
}

export interface EntraResetPasswordResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  deliveryMethod?: string;
  notificationEmail?: string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never>, ctx?: { verifiedUpn?: string; userSessionHandle?: string }): Promise<EntraResetPasswordResult> {
  // Subject comes from the verified session, never from args — see
  // ToolRunContext.verifiedUpn in electron/agent/guards/execution.ts.
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }
  const upn = encodeURIComponent(ctx.verifiedUpn);
  const path = `/entra/users/${upn}/password/reset`;

  const r = await cloudGatewayCall<EntraResetPasswordData>({
    method: "POST",
    path,
    userSessionHandle: ctx?.userSessionHandle,
  });

  if (r.status !== "ok") {
    return {
      status:        r.status === "not-configured" ? "not-configured" : "failed",
      message:       r.message,
      httpStatus:    r.httpStatus,
      failureReason: r.failureReason,
    };
  }

  const d = r.data!;
  return {
    status:  d.status === "initiated" ? "ok" : "failed",
    message: d.message,
    ...(d.deliveryMethod != null && { deliveryMethod: d.deliveryMethod }),
    ...(d.notificationEmail != null && { notificationEmail: d.notificationEmail }),
  };
}
