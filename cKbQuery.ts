/**
 * c_kb_query
 *
 * Answers a question from the tenant's connected knowledge sources (HR,
 * finance, payroll, benefits, written policy) via the cloud gateway.
 *
 * ─── Why the loop is server-side ─────────────────────────────────────────────
 * This is the opposite of every other c_* tool, and deliberately so. Those are
 * REST operations with known shapes generated from OpenAPI; the tenant's
 * knowledge sources are MCP servers exposing TYPED TOOLS
 * (`get_time_off_balance`, `list_policies`, `get_payslip`), not a search
 * endpoint. Turning "what's the parental leave policy" into the right call on
 * the right server IS an LLM job, so a loop exists server-side whether or not
 * the contract admits it.
 *
 * Three consequences, all better there than here: OAuth tokens for a payroll
 * system never reach a laptop; the agent sees one stable tool name while MCP
 * registers tools dynamically (G2 validates plans against a STATIC
 * allowed-tools, so a dynamic surface here would break it); and third-party
 * text is scrubbed before it crosses to a device rather than after.
 *
 * ─── Self-gating ─────────────────────────────────────────────────────────────
 * No KB-specific env var, by design (CONVERSATION-LAYER.md §12): the shared
 * `cloudGatewayCall` helper already returns `status: "not-configured"` when
 * CLOUD_GATEWAY_URL or the API key is unset, so the lane is inert on a tenant
 * without a gateway and the caller treats it exactly like a miss.
 *
 * ─── Tenant-scoped only, for now ─────────────────────────────────────────────
 * "What is the parental leave policy" — yes. "How much is my next paycheck" —
 * later: user-scoped answers need delegated per-user auth. That is why
 * `requiresVerifiedIdentity` is false: the flag is emitted only for a
 * gatewayPath carrying {upn}, so a tenant-wide lookup never triggers a sign-in.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_GATEWAY_URL}/kb/query   { query }
 *   X-Idemeum-Eoc-Api-Key: ${CLOUD_GATEWAY_API_KEY}
 *
 * The loop itself runs in idemeum Automate, not the gateway; the gateway fronts
 * it, so this agent only ever talks to the gateway.
 *
 * See docs/architecture/CONVERSATION-LAYER.md §5.3.
 */

import { cloudGatewayCall, type CloudGatewayResult } from "./_shared/cloudGateway";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_kb_query",
  description:
    "Answers a question from the tenant's connected knowledge sources (HR, finance, payroll, " +
    "benefits, written policy). Returns a synthesised answer with citations via the cloud gateway.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  /**
   * Conditional, and worth knowing which path honours it: the audit-row
   * decision lives in executeStep(), so this fires when a SKILL lists
   * c_kb_query in allowed-tools and the executor invokes it. In the `answer`
   * lane there is no plan and no G4, so no task_logs row is written and the
   * audit trail is the ticket payload instead (§3.4 stage 16).
   */
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresVerifiedIdentity: false,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "answer",
    "citations",
    "sourcesConsulted",
    "answered",
    "usage",
    "httpStatus",
    "failureReason",
  ],
  schema: { query: "string" },
} as const;

// -- Types --------------------------------------------------------------------

export interface KbCitation {
  source: string;
  title:  string;
  /**
   * Optional, and often absent. MCP tools return FACTS as well as documents —
   * `get_time_off_balance` gives a number with nothing to link to — so a
   * citation with no url renders as plain text, never a dead link.
   */
  url?:   string;
}

export interface KbUsage {
  inputTokens?:  number;
  outputTokens?: number;
  model?:        string;
}

interface KbQueryData {
  answer?:           string;
  citations?:        KbCitation[];
  sourcesConsulted?: string[];
  answered?:         boolean;
  usage?:            KbUsage;
}

export interface KbQueryResult {
  status:  "ok" | "failed" | "not-configured";
  message: string;
  answer?:           string;
  citations?:        KbCitation[];
  /** Which servers actually responded — an admin-facing signal, rendered as-is. */
  sourcesConsulted?: string[];
  /**
   * The EXPLICIT not-in-KB signal. Never infer absence from an empty `answer`:
   * this is what drives the triage offer, and a server that searched and found
   * nothing is a different thing from a server that returned a short answer.
   */
  answered?:         boolean;
  /**
   * Server-side token usage. This is why `llmUsage` stays accurate even though
   * the LLM call happened elsewhere — the agent stamps these figures onto its
   * payload exactly as it would for a local call.
   */
  usage?:            KbUsage;
  httpStatus?:       number;
  failureReason?:    CloudGatewayResult["failureReason"];
}

// -- Implementation -----------------------------------------------------------

/**
 * Behind the gateway, the automate service runs a bounded LLM loop over the
 * tenant's MCP servers, so this call is slower than a REST proxy and the
 * default 10 s response timeout is too tight. Overridable for a tenant with
 * slow upstreams.
 */
function resolveKbTimeout(): number {
  const v = parseInt(process.env["CLOUD_KB_RESPONSE_TIMEOUT_MS"] ?? "30000", 10);
  return isNaN(v) || v <= 0 ? 30_000 : v;
}

export async function run(
  args: { query?: string },
  ctx?: { userSessionHandle?: string },
): Promise<KbQueryResult> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { status: "failed", message: "No question supplied.", answered: false };
  }

  const r = await cloudGatewayCall<KbQueryData>({
    method: "POST",
    path:   "/kb/query",
    body:   { query },
    timeoutMs: resolveKbTimeout(),
    // Its own breaker: a KB outage must not open the circuit on the entra
    // routes, and vice versa. The loop here is slow and the REST routes are
    // not, so one shared failure budget would mis-attribute both.
    breakerKey: "CLOUD_KB_URL",
    ...(ctx?.userSessionHandle ? { userSessionHandle: ctx.userSessionHandle } : {}),
  });

  if (r.status !== "ok") {
    return {
      status:        r.status,
      message:       r.message,
      // A gateway failure, an open circuit and a missing gateway are all
      // "we could not answer this" as far as the caller is concerned — which
      // is better than pretending an answer exists (§14).
      answered:      false,
      ...(r.httpStatus    !== undefined ? { httpStatus: r.httpStatus }       : {}),
      ...(r.failureReason !== undefined ? { failureReason: r.failureReason } : {}),
    };
  }

  const d = r.data ?? {};
  const answered = d.answered === true && typeof d.answer === "string" && d.answer.trim().length > 0;

  return {
    status:  "ok",
    message: answered ? "Answered from the connected knowledge sources." : "No answer found.",
    answered,
    ...(d.answer           !== undefined ? { answer: d.answer }                     : {}),
    ...(Array.isArray(d.citations)        ? { citations: d.citations }               : {}),
    ...(Array.isArray(d.sourcesConsulted) ? { sourcesConsulted: d.sourcesConsulted } : {}),
    ...(d.usage            !== undefined ? { usage: d.usage }                       : {}),
    ...(r.httpStatus       !== undefined ? { httpStatus: r.httpStatus }             : {}),
  };
}
