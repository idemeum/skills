/**
 * mcp/skills/cRecordTriage.ts — c_record_triage, the triage skill's record step
 *
 * The same tool name and parameters as Automate's built-in `c_record_triage`
 * (src/tools/recordTriage.ts, field for field), so the step reads the same in
 * both agents. In Assist it is a **user-wait gate**, like `present_preview`
 * and `request_user_input`: the executor LLM writes the record, and the user
 * reviews it on the intake form before anything is sent to IT.
 *
 * The schema is written inline in `meta`, without helper constants, so the
 * static readers of tool files (sync-skills-tools-payload.js, the skill
 * contract tests) see every parameter.
 *
 * Routing
 * -------
 * G4's executeStep() detects `meta.isUserWaitGate === true` and routes this
 * tool to `runRecordTriageGate()` in electron/agent/guards/execution.ts
 * instead of calling run(). Before the gate, code holds the record's
 * category to the planner's (binding), and a category not in the skill's
 * `metadata.triage.categories` is refused so the executor chooses again.
 *
 * What it returns
 * ---------------
 * An acknowledgement, `{ status: "recorded", action }` — not the record, so
 * the record is not repeated in the ticket's `steps[].diagnostics`. The
 * reviewed record is kept for the runtime, which posts it as the payload's
 * `triage` block. `action` is "submit" (Submit to IT), "continue" (ticketing
 * off) or "cancel" (Cancel, the 15-minute timeout, or an abort).
 *
 * See docs/architecture/TRIAGE-ARCHITECTURE.md § Intake form gate and § Cancel.
 */

import { z } from "zod";

import type { UrgencyLevel } from "./_shared/triageRecord";


// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_record_triage",
  description:
    "Records the triage of a request no skill could fix — what it is, how urgent, what the " +
    "diagnostics found and what IT should do first — and shows it to the user on the intake " +
    "form to review before it is sent to IT. Call it last, once, after every diagnostic in the " +
    "plan. It changes nothing.\n" +
    "\n" +
    "IMPORTANT — this is a user-wait GATE, not a regular tool. G4 bypasses " +
    "the 60s TOOL_TIMEOUT_MS ceiling for this call and instead races the " +
    "user's interaction against USER_ACK_TIMEOUT_MS (default 15 min). The " +
    "gate injects `ticketingEnabled` from deployment config — do NOT pass " +
    "it as a tool param.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"] as const,
  auditRequired:   false,
  isUserWaitGate:  true,
  // The step the run exists for: plan-order enforcement requires it, after
  // the diagnostic — unlike the other user-wait gates.
  planOrdered:     true,
  // The planner picks the category, with the diagnostic for it; code holds
  // the record to it (binding.ts).
  planBoundParams: ["category"],
  outputKeys: ["status", "action"],
  // The parameters — the LLM-written part of the triage record.
  schema: {
    kind: z.enum(["issue", "request"]).describe("issue: something is broken. request: something is wanted."),
    category: z
      .array(z.string().trim().min(1))
      .min(1)
      .describe("The category path, top level first. Set by the plan — pass it as given."),
    categoryCertainty: z.number().min(0).max(100).describe("How sure you are, 0–100."),
    urgency: z
      .enum(["critical", "high", "medium", "low"]) // URGENCY_LEVELS, literal for the static readers
      .describe("critical: cannot work at all; high: no workaround; medium: a workaround exists; low: cosmetic."),
    urgencyCertainty: z.number().min(0).max(100).describe("How sure you are, 0–100."),
    affectedSystem: z
      .string().trim().min(1)
      .describe('The primary app, device or service, by its common name; "Unknown" only when nothing can be inferred.'),
    symptoms: z.array(z.string().trim().min(1)).describe("Short phrases."),
    tags: z.array(z.string().trim().min(1)).describe("Keywords for search and reporting."),
    sentiment: z.string().trim().min(1).describe("The requester's tone: neutral, frustrated, urgent …"),
    issueSummary: z
      .string().trim().min(1)
      .describe("1–2 sentences a technician understands without the ticket: what, where, when."),
    entities: z
      .object({
        persons:   z.array(z.string().trim().min(1)),
        devices:   z.array(z.string().trim().min(1)),
        software:  z.array(z.string().trim().min(1)),
        vendors:   z.array(z.string().trim().min(1)),
        locations: z.array(z.string().trim().min(1)),
        accounts:  z.array(z.string().trim().min(1)),
      })
      .strict()
      .describe("Identifiers named in the ticket. Never a password or other secret."),
    evidence: z
      .array(z.object({ source: z.string().trim().min(1), reason: z.string().trim().min(1), findings: z.array(z.string().trim().min(1)) }).strict())
      .describe("One entry per lookup that ran: the tool, why it ran, what it showed in plain words."),
    recommendations: z
      .object({
        nextSteps: z.array(z.string().trim().min(1)),
        alerts:    z.array(z.object({ type: z.string().trim().min(1), detail: z.string().trim().min(1) }).strict()),
      })
      .strict(),
    automation: z
      .object({
        score:              z.number().min(0).max(100),
        relevantConnectors: z.array(z.string().trim().min(1)),
        recommendation:     z.string(),
      })
      .strict()
      .describe("How much of this the tenant's connectors could have done, and the skill worth writing."),
  },
} as const;

export const recordTriageSchema = meta.schema;

export type RecordTriageParams = z.infer<z.ZodObject<typeof recordTriageSchema>>;

// The literal enum above must stay URGENCY_LEVELS: a mismatch fails to compile here.
const _urgencyMatches: UrgencyLevel = "" as RecordTriageParams["urgency"];
const _urgencyCovers: RecordTriageParams["urgency"] = "" as UrgencyLevel;
void _urgencyMatches; void _urgencyCovers;

// -- Exported run function ----------------------------------------------------

/**
 * Safety-net stub.  The run() function is never invoked on the normal path —
 * G4's executeStep() detects meta.isUserWaitGate and routes to
 * runRecordTriageGate() before the tool-execution block.  If this throws,
 * the routing is broken.
 */
export async function run(): Promise<never> {
  throw new Error(
    "c_record_triage.run() was invoked directly — this should never happen. " +
    "G4 is expected to route steps whose tool.meta.isUserWaitGate is true " +
    "through runRecordTriageGate() in electron/agent/guards/execution.ts, bypassing " +
    "the normal tool-execution pipeline. Check G4's executeStep() routing.",
  );
}
