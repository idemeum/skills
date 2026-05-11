/**
 * mcp/skills/requestIdemeumIdpReset.ts — request_idemeum_idp_reset
 *
 * Fallback password-reset path: when the IDP's self-service portal is
 * disabled (or the user tried and failed), the agent POSTs to idemeum
 * cloud, which holds pre-configured admin-delegated IDP credentials
 * (Okta admin API tokens, Entra graph permissions, Google Workspace
 * admin SDK) and invokes the IDP's admin API to trigger the reset.
 *
 * The agent never sees IDP admin credentials — those live only on the
 * idemeum cloud service.  The agent's role is to forward context
 * (agentId, username, idp, tenant, platform) and surface the response.
 *
 * Wire contract
 * -------------
 * POST ${IDEMEUM_IDP_URL}/v1/password-reset
 *   Authorization: Bearer ${IDEMEUM_IDP_API_KEY}
 *   Body: { agentId, username, idp, tenant, platform }
 *
 *   Success  → { status: "initiated", deliveryMethod, message, ticketId? }
 *   Failure  → { status: "failed",    message }
 *   Refused  → { status: "not-eligible", message }
 *
 * When IDEMEUM_IDP_URL is unset, the tool resolves fail-open with
 * { status: "not-configured", message: "…" } so the skill prose can
 * still branch gracefully.
 *
 * Guardrail declarations (see docs/skills/SKILL-ROADMAP.md § Guardrail table):
 *   riskLevel:       "high"   — identity-level impact
 *   destructive:     false    — mutation happens in the cloud, not locally
 *   requiresConsent: true
 *   supportsDryRun:  true     — dry-run shows the exact outbound payload
 *   affectedScope:   ["network"]
 *   auditRequired:   true
 */

import * as os from "os";
import { z }   from "zod";

import { httpPost } from "./_shared/platform";
import type { Idp } from "./_shared/idp";

/**
 * Local copy of getAgentId() — mirrors electron/agent/agentId.ts.
 * Duplicated here because the skill compiles with rootDir=mcp/skills so
 * it cannot import from the electron/ tree.  Behaviour must stay in
 * lock-step: trimmed AGENT_ID env var, empty string when unset.
 */
function getAgentId(): string {
  const raw = process.env["AGENT_ID"];
  if (raw === undefined) return "";
  const trimmed = raw.trim();
  return trimmed;
}

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "request_idemeum_idp_reset",
  description:
    "Fallback path when the IDP's self-service portal is unavailable. POSTs " +
    "to idemeum cloud, which holds admin-delegated IDP credentials per " +
    "customer and triggers or performs the reset via the IDP admin API. " +
    "The agent never sees IDP admin credentials. Response indicates how the " +
    "reset was delivered (e.g. temp password emailed to recovery address).",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["network"],
  auditRequired:   true,
  schema: {
    idp: z
      .enum(["okta", "entra", "google"])
      .describe("IDP identifier; JumpCloud/Ping deferred to Wave 2."),
    username: z
      .string()
      .min(1)
      .describe("The user's IDP login (email / UPN)."),
    tenant: z
      .string()
      .optional()
      .describe("IDP tenant slug (Okta) or directory id (Entra); optional for Google."),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "When true, return { willPost, endpoint, payloadWithoutSecrets } " +
        "without posting. The Bearer token is never included even in dry-run.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

/** Wire-format body POSTed to idemeum cloud. */
interface CloudResetPayload {
  agentId:  string;
  username: string;
  idp:      Idp;
  tenant:   string | null;
  platform: "darwin" | "win32" | "other";
}

export type CloudResetStatus =
  | "initiated"
  | "failed"
  | "not-eligible"
  | "not-configured";

export interface CloudResetResult {
  status:          CloudResetStatus;
  message:         string;
  deliveryMethod?: "email" | "sms" | "helpdesk-ticket";
  ticketId?:       string;
  /** Present on dry-run. */
  willPost?:              boolean;
  endpoint?:              string;
  payloadWithoutSecrets?: CloudResetPayload;
  /** Present on network / http errors. */
  httpStatus?:     number;
  failureReason?:  "connect_timeout" | "response_timeout" | "network" | "circuit_open" | "http" | "parse";
}

// -- Implementation -----------------------------------------------------------

function resolvePlatform(): "darwin" | "win32" | "other" {
  const p = os.platform();
  if (p === "darwin") return "darwin";
  if (p === "win32")  return "win32";
  return "other";
}

function buildPayload(args: {
  idp: Idp; username: string; tenant?: string;
}): CloudResetPayload {
  return {
    agentId:  getAgentId(),
    username: args.username,
    idp:      args.idp,
    tenant:   args.tenant && args.tenant.length > 0 ? args.tenant : null,
    platform: resolvePlatform(),
  };
}

/** Exported so tests can drive the payload builder directly. */
export const __testing = { buildPayload };

// -- Exported run function ----------------------------------------------------

export async function run(args: {
  idp:      Idp;
  username: string;
  tenant?:  string;
  dryRun?:  boolean;
}): Promise<CloudResetResult> {
  const url    = process.env["IDEMEUM_IDP_URL"];
  const apiKey = process.env["IDEMEUM_IDP_API_KEY"];

  if (!url || url.length === 0) {
    return {
      status:  "not-configured",
      message:
        "idemeum cloud fallback is not configured on this machine. " +
        "Contact your MSP administrator to enable IDEMEUM_IDP_URL.",
    };
  }

  const endpoint = url.replace(/\/$/, "") + "/v1/password-reset";
  const payload  = buildPayload(args);

  if (args.dryRun) {
    return {
      status:  "initiated", // semantic placeholder — dry-run never executes
      message: `Would POST idemeum cloud reset request for ${args.username} (${args.idp}).`,
      willPost:              true,
      endpoint,
      // NEVER include the Bearer token in dry-run output.
      payloadWithoutSecrets: payload,
    };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept":       "application/json",
  };
  if (apiKey && apiKey.length > 0) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body = JSON.stringify(payload);
  const responseTimeoutMs = (() => {
    const v = parseInt(process.env["IDEMEUM_IDP_RESPONSE_TIMEOUT_MS"] ?? "10000", 10);
    return isNaN(v) || v <= 0 ? 10_000 : v;
  })();
  const r = await httpPost(endpoint, body, headers, {
    timeoutMs:  responseTimeoutMs,
    breakerKey: "IDEMEUM_IDP_URL",
  });

  if (r.failureReason) {
    const isTimeout = r.failureReason === "connect_timeout" || r.failureReason === "response_timeout";
    const isOpen    = r.failureReason === "circuit_open";
    return {
      status:        "failed",
      failureReason: r.failureReason,
      message:
        isOpen
          ? `idemeum cloud unavailable — circuit open for ${endpoint}.`
          : isTimeout
            ? `idemeum cloud reset request timed out contacting ${endpoint}.`
            : `Could not reach idemeum cloud at ${endpoint}.`,
    };
  }

  if (r.statusCode < 200 || r.statusCode >= 300) {
    return {
      status:        "failed",
      failureReason: "http",
      httpStatus:    r.statusCode,
      message:
        `idemeum cloud returned HTTP ${r.statusCode}. ` +
        `Please contact your MSP administrator.`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return {
      status:        "failed",
      failureReason: "parse",
      httpStatus:    r.statusCode,
      message:       "idemeum cloud returned a non-JSON response.",
    };
  }

  const rawStatus  = typeof parsed["status"]  === "string" ? (parsed["status"] as string) : "";
  const rawMessage = typeof parsed["message"] === "string" ? (parsed["message"] as string) : "";
  const rawDelivery = typeof parsed["deliveryMethod"] === "string"
    ? (parsed["deliveryMethod"] as string)
    : undefined;
  const rawTicketId = typeof parsed["ticketId"] === "string"
    ? (parsed["ticketId"] as string)
    : undefined;

  const status: CloudResetStatus =
    rawStatus === "initiated" || rawStatus === "failed" || rawStatus === "not-eligible"
      ? rawStatus
      : "failed";

  const deliveryMethod =
    rawDelivery === "email" || rawDelivery === "sms" || rawDelivery === "helpdesk-ticket"
      ? rawDelivery
      : undefined;

  return {
    status,
    message:  rawMessage.length > 0
      ? rawMessage
      : `idemeum cloud responded with status "${status}".`,
    deliveryMethod,
    ticketId: rawTicketId,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "okta", username: "alice@example.com", tenant: "acme", dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
