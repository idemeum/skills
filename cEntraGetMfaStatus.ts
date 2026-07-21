/**
 * mcp/skills/cEntraGetMfaStatus.ts — c_entra_get_mfa_status
 *
 * Diagnostic cloud-proxy tool: fetches an Entra user's MFA registration
 * status, registered methods, and default method via the cloud gateway.
 *
 * Wire contract
 * -------------
 * GET ${CLOUD_GATEWAY_URL}/entra/users/{upn}/mfa
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   → { methods: [{ type, isDefault }], registrationComplete }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_entra_get_mfa_status",
  description:
    "Fetches an Entra user's MFA registration status via the cloud gateway. " +
    "Returns registered authentication methods (phone, authenticator app, " +
    "FIDO2, etc.), which is the default, and whether registration is complete.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  sensitiveParams: ["userPrincipalName"],
  outputKeys: [
    "status", "message", "methods", "registrationComplete",
    "httpStatus", "failureReason",
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

interface MfaMethod {
  type:      string;
  isDefault: boolean;
}

interface EntraMfaData {
  methods:              MfaMethod[];
  registrationComplete: boolean;
}

export interface EntraGetMfaStatusResult {
  status:                "ok" | "failed" | "not-configured";
  message:               string;
  methods?:              MfaMethod[];
  registrationComplete?: boolean;
  httpStatus?:           number;
  failureReason?:        CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(args: {
  userPrincipalName: string;
}): Promise<EntraGetMfaStatusResult> {
  const upn = encodeURIComponent(args.userPrincipalName);
  const r = await cloudGatewayCall<EntraMfaData>({
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
  const methodCount = d.methods?.length ?? 0;
  const defaultMethod = d.methods?.find((m) => m.isDefault);

  return {
    status:               "ok",
    message:              methodCount > 0
      ? `${methodCount} MFA method(s) registered. Default: ${defaultMethod?.type ?? "none"}.`
      : "No MFA methods registered.",
    methods:              d.methods,
    registrationComplete: d.registrationComplete,
  };
}
