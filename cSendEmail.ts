/**
 * c_send_email
 *
 * Sends an email to the verified user via the cloud gateway.
 * The gateway resolves the recipient from the session handle —
 * the agent never controls who receives the message.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/api/eoc/email/send
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *   X-Idemeum-User-Session: ${userSessionHandle}
 *   Body: { "subject": "...", "body": "..." }
 */

import { z } from "zod";
import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_send_email",
  description:
    "Sends an email to the user via the cloud gateway. " +
    "The recipient is resolved server-side from the verified session — " +
    "the agent cannot control who receives the message. " +
    "Use this to deliver summaries, instructions, or confirmation details " +
    "that the user will need after the conversation ends.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "httpStatus",
    "failureReason",
  ],
  schema: {
    subject: z.string().min(1).max(200).describe(
      "Email subject line. Keep it short and descriptive.",
    ),
    body: z.string().min(1).max(10_000).describe(
      "Plain-text email body. May include the resolution summary, " +
      "steps taken, or follow-up instructions for the user.",
    ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface SendEmailData {
  status:  "sent" | "failed";
  message: string;
}

export interface SendEmailResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  httpStatus?:    number;
  failureReason?: CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

export async function run(
  args: { subject: string; body: string },
  ctx?: { verifiedUpn?: string; userSessionHandle?: string },
): Promise<SendEmailResult> {
  if (!ctx?.verifiedUpn) {
    return {
      status:  "failed",
      message: "No verified identity for this run.",
    } as never;
  }

  const r = await cloudGatewayCall<SendEmailData>({
    method: "POST",
    path:   "/email/send",
    body:   { subject: args.subject, body: args.body },
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
    status:  d.status === "sent" ? "ok" : "failed",
    message: d.message,
  };
}
