/**
 * c_kb_query
 *
 * Answers a question from the tenant's connected knowledge sources (HR,
 * finance, payroll, benefits, written policy) via idemeum Automate.
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
 * ─── Why this one does NOT go through the gateway ────────────────────────────
 * Every other c_* tool calls the gateway. This one calls idemeum Automate
 * directly, because that is where the orchestrator loop runs and fronting a
 * long-running agentic loop behind a proxy buys nothing. Automate is a SIBLING
 * host of the tenant — automate.<domain>, not a path under TENANT_URL — so it
 * needs its own URL and its own auth headers.
 *
 * ─── Self-gating ─────────────────────────────────────────────────────────────
 * The lane is inert on a tenant without Automate: unset CLOUD_KB_URL (or the
 * key) and this returns `status: "not-configured"`, which the caller treats
 * exactly like a miss (CONVERSATION-LAYER.md §12).
 *
 * ─── Tenant-scoped only, for now ─────────────────────────────────────────────
 * "What is the parental leave policy" — yes. "How much is my next paycheck" —
 * later: user-scoped answers need delegated per-user auth. `requiresVerifiedIdentity`
 * is false because the call is tenant-scoped and carries no user subject — which
 * is what keeps a KB question from triggering a sign-in. It flips the day answers
 * become user-scoped.
 *
 * Wire contract
 * -------------
 * POST ${CLOUD_KB_URL}                 { query }
 *   X-Idemeum-Automate-Tenant:  ${CLOUD_KB_TENANT}   <- subdomain LABEL, not host
 *   X-Idemeum-Automate-Api-Key: ${CLOUD_KB_API_KEY}
 *
 * CLOUD_KB_URL is the FULL endpoint, not a base: the installer writes
 * ${scheme}://automate.${domain}/kb/query. Both headers are required —
 * Automate is multi-tenant and resolves the tenant from the header, not from
 * the key. The URL and tenant are written by build/scripts/postinstall and
 * scripts/install-exe.ps1 alongside CLOUD_GATEWAY_URL. The KEY is not — no
 * *_API_KEY is written in that block; IDEMEUM_API_KEY is written once in the
 * credentials block and every consumer falls back to it in code, which is what
 * resolveKbApiKey() below does. CLOUD_KB_API_KEY is an optional override.
 *
 * See docs/architecture/CONVERSATION-LAYER.md §5.3.
 */

import { httpPost } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_kb_query",
  description:
    "Answers a question from the tenant's connected knowledge sources (HR, finance, payroll, " +
    "benefits, written policy). Returns a synthesised answer with citations via idemeum Automate.",
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

export type KbFailureReason =
  | "connect_timeout" | "response_timeout" | "network" | "circuit_open" | "http" | "parse";

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
  inputTokens?:         number;
  outputTokens?:        number;
  /**
   * Prompt-cache counters, returned by Automate's /kb/query alongside the
   * plain token counts. Carried through unchanged so the portal's cost
   * formula sees the same shape it does for a run — cached input is billed
   * differently from fresh input, so dropping these would overstate cost.
   */
  cacheReadTokens?:     number;
  cacheCreationTokens?: number;
  model?:               string;
  /**
   * Only if Automate reports it. It resolves llmProvider per tenant from its
   * own config, so this is authoritative when present; the agent falls back to
   * its own ACTIVE_LLM, which holds because a tenant's Automate and its
   * devices are deployed on the same provider.
   */
  provider?:            string;
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
  failureReason?:    KbFailureReason;
}

// -- Implementation -----------------------------------------------------------

/**
 * Automate runs a bounded LLM loop over the tenant's MCP servers, so this call
 * is slower than a REST proxy and the default 10 s response timeout is too
 * tight. Overridable for a tenant with slow upstreams.
 */
function resolveKbTimeout(): number {
  const v = parseInt(process.env["CLOUD_KB_RESPONSE_TIMEOUT_MS"] ?? "30000", 10);
  return isNaN(v) || v <= 0 ? 30_000 : v;
}

/**
 * Falls back to IDEMEUM_API_KEY, the same pattern every other outbound key
 * follows (TICKET_API_KEY, CLOUD_ENV_API_KEY …). The installer writes
 * CLOUD_KB_API_KEY explicitly; the fallback covers a hand-edited .env.
 */
function resolveKbApiKey(): string {
  return (
    process.env["CLOUD_KB_API_KEY"] ??
    process.env["IDEMEUM_API_KEY"] ??
    ""
  ).trim();
}

export async function run(
  args: { query?: string },
): Promise<KbQueryResult> {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) {
    return { status: "failed", message: "No question supplied.", answered: false };
  }

  const endpoint = (process.env["CLOUD_KB_URL"] ?? "").trim();
  const apiKey   = resolveKbApiKey();
  const tenant   = (process.env["CLOUD_KB_TENANT"] ?? "").trim();

  // Fail closed rather than calling Automate without credentials — the same
  // reasoning as cloudGateway's: an unauthenticated call surfaces a 401 that
  // reads as a lookup failure when it is really a provisioning problem.
  if (!endpoint || !apiKey || !tenant) {
    const missing = [
      !endpoint ? "CLOUD_KB_URL" : null,
      !apiKey   ? "CLOUD_KB_API_KEY" : null,
      !tenant   ? "CLOUD_KB_TENANT"  : null,
    ].filter(Boolean).join(", ");
    return {
      status:  "not-configured",
      message: `Knowledge base is not configured on this machine (${missing}). ` +
               "Contact your MSP administrator.",
      answered: false,
    };
  }

  // Its own breaker: the KB loop is slow and the gateway's REST routes are not,
  // so one shared failure budget would mis-attribute both. A KB outage must not
  // open the circuit on the entra routes, or vice versa.
  const r = await httpPost(
    endpoint,
    JSON.stringify({ query }),
    {
      "Content-Type":              "application/json",
      "Accept":                    "application/json",
      "X-Idemeum-Automate-Tenant":  tenant,
      "X-Idemeum-Automate-Api-Key": apiKey,
    },
    { timeoutMs: resolveKbTimeout(), breakerKey: "CLOUD_KB_URL" },
  );

  if (r.failureReason) {
    const isTimeout =
      r.failureReason === "connect_timeout" || r.failureReason === "response_timeout";
    return {
      status:        "failed",
      failureReason: r.failureReason,
      // An Automate failure, an open circuit and a missing endpoint are all
      // "we could not answer this" as far as the caller is concerned — which
      // is better than pretending an answer exists (§14).
      answered:      false,
      message:
        r.failureReason === "circuit_open"
          ? "Knowledge base unavailable — circuit open."
          : isTimeout
            ? "Knowledge base request timed out."
            : "Could not reach the knowledge base.",
    };
  }

  if (r.statusCode < 200 || r.statusCode >= 300) {
    return {
      status:        "failed",
      failureReason: "http",
      httpStatus:    r.statusCode,
      answered:      false,
      message:       `Knowledge base returned HTTP ${r.statusCode}.`,
    };
  }

  let d: KbQueryData;
  try {
    d = JSON.parse(r.body) as KbQueryData;
  } catch {
    return {
      status:        "failed",
      failureReason: "parse",
      httpStatus:    r.statusCode,
      answered:      false,
      message:       "Knowledge base returned a non-JSON response.",
    };
  }

  const answered =
    d.answered === true && typeof d.answer === "string" && d.answer.trim().length > 0;

  return {
    status:  "ok",
    message: answered ? "Answered from the connected knowledge sources." : "No answer found.",
    answered,
    ...(d.answer           !== undefined ? { answer: d.answer }                     : {}),
    ...(Array.isArray(d.citations)        ? { citations: d.citations }               : {}),
    ...(Array.isArray(d.sourcesConsulted) ? { sourcesConsulted: d.sourcesConsulted } : {}),
    ...(d.usage            !== undefined ? { usage: d.usage }                       : {}),
    httpStatus: r.statusCode,
  };
}
