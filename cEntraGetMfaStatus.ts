/**
 * c_entra_get_mfa_status
 *
 * Diagnostic cloud-proxy tool: fetches an entra user's mfa registration status. returns registered authentication methods (phone, authenticator app, fido2, etc.) and whether registration is complete via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/mfa
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_mfa_status",
  description:
    "Fetches an Entra user's MFA registration status. Returns registered authentication methods (phone, authenticator app, FIDO2, etc.) and whether registration is complete via the cloud gateway.",
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
    "methods",
    "registrationComplete",
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

interface MethodsEntry {
  type: string;
  id: string;
}
interface EntraGetMfaStatusData {
  registrationComplete: boolean;
  methods: MethodsEntry[];
}

export interface EntraGetMfaStatusResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  registrationComplete?: boolean;
  methods?: MethodsEntry[];
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetMfaStatusResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraGetMfaStatusData>({
    path: `/entra/users/${upn}/mfa`,
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
    message: (Array.isArray(d.methods) ? d.methods.length : 0) + " MFA method(s) registered.",
    registrationComplete: d.registrationComplete,
    methods: d.methods,
  };
}
