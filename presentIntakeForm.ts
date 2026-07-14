/**
 * mcp/skills/presentIntakeForm.ts — present_intake_form synthetic user-wait gate
 *
 * Fourth user-wait gate alongside `present_preview` (multi-select card),
 * `wait_for_user_ack` (button picker), and `request_user_input` (text input).
 * This one presents a **structured intake form** pre-filled by the executor
 * LLM for the user to review and edit before ticket submission.
 *
 * Why this exists
 * ---------------
 * When the skill router exhausts its clarification rounds without matching a
 * skill (the "unclear" branch), runtime.ts falls through to the `triage`
 * skill.  The triage SKILL.md instructs the executor LLM to extract structured
 * fields (category, urgency, summary, affected system, symptoms) from the
 * accumulated clarification context and pass them as tool params.  This gate
 * renders them as an editable form so the user can correct any misclassification
 * before the data flows into the post-execution ticket payload.
 *
 * Routing
 * -------
 * G4's executeStep() detects `meta.isUserWaitGate === true` and routes
 * this tool through `runIntakeFormGate()` rather than the normal
 * tool-execution pipeline.  The dispatcher in execution.ts switches on
 * tool name:
 *   - present_preview      → runPresentPreviewGate (multi-select card)
 *   - request_user_input   → runUserInputGate      (text input)
 *   - present_intake_form  → runIntakeFormGate      (editable intake form)
 *   - wait_for_user_ack    → runUserAckGate         (button picker, fallback)
 *
 * Ticket flow
 * -----------
 * The gate result lands in `g4StepResults` as a `G4StepSummary` with
 * `output` containing the reviewed fields.  The existing `toTicketSteps()`
 * in ticketing.ts populates `TicketStep.diagnostics` automatically (this
 * tool is non-destructive + non-consent-gated + outcome is "approved").
 * No separate submit_ticket tool is needed — the existing post-execution
 * `createTicket()` call handles submission.
 *
 * Returns
 * -------
 *   { category, urgency, summary, affectedSystem, symptoms, additionalNotes?, action }
 *
 * `action` is "submit" when the user clicks Submit/Copy, "cancel" on
 * dismiss/timeout/abort.  Downstream steps and the ticket payload both
 * branch on `action`.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/presentIntakeForm.ts
 */

import { z } from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "present_intake_form",
  description:
    "Presents a structured intake form pre-filled by the executor LLM for user " +
    "review and editing before ticket submission. Use in the triage skill when " +
    "no specific workflow matched the user's request after clarification rounds.\n" +
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
  outputKeys: [],
  schema: {
    title: z
      .string()
      .min(1)
      .describe("Card heading shown above the form (e.g. 'Review your IT request')."),
    category: z
      .string()
      .min(1)
      .describe(
        "IT issue category extracted from the user's description. Must be one of: " +
        "Network, Software, Hardware, Account/Access, Email, Printing, " +
        "Performance, Security, Other.",
      ),
    urgency: z
      .enum(["low", "medium", "high", "critical"])
      .describe(
        "Urgency level: critical = system/account completely unusable; " +
        "high = significant workflow impact; medium = inconvenience with " +
        "workaround available; low = informational or cosmetic.",
      ),
    summary: z
      .string()
      .min(1)
      .describe(
        "1-2 sentence plain-English summary of the issue extracted from the " +
        "user's description and clarification answers.",
      ),
    affectedSystem: z
      .string()
      .min(1)
      .describe(
        "The primary system, application, or device affected " +
        "(e.g. 'Wi-Fi', 'Outlook', 'MacBook Pro').",
      ),
    symptoms: z
      .array(z.string())
      .describe(
        "List of specific symptoms the user described. Each entry should be " +
        "a short phrase (e.g. 'Wi-Fi drops every 10 minutes').",
      ),
  },
} as const;

// -- Exported run function ----------------------------------------------------

/**
 * Safety-net stub.  The run() function is never invoked on the normal path —
 * G4's executeStep() detects meta.isUserWaitGate and routes to
 * runIntakeFormGate() before the tool-execution block.  If this throws,
 * the routing is broken.
 */
export async function run(): Promise<never> {
  throw new Error(
    "present_intake_form.run() was invoked directly — this should never happen. " +
    "G4 is expected to route steps whose tool.meta.isUserWaitGate is true " +
    "through runIntakeFormGate() in electron/agent/guards/execution.ts, bypassing " +
    "the normal tool-execution pipeline. Check G4's executeStep() routing.",
  );
}
