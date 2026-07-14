/**
 * mcp/skills/requestUserInput.ts — request_user_input synthetic user-wait gate
 *
 * Third user-wait gate alongside `wait_for_user_ack` (button picker) and
 * `present_preview` (multi-select card). This one captures **free-text input**
 * from the user mid-plan and returns it as `{ value: string }`.
 *
 * Why this exists
 * ---------------
 * SKILL.md authors frequently write prose like "ask the user via chat for
 * their printer IP" or "ask if not known" — these are functionally broken
 * in the current ReAct loop because the conversationIdRef clears on run
 * end (see useAgent.ts:156). When the LLM emits a text response asking a
 * question, the run terminates and the next user message starts a fresh
 * conversation with no memory of the prior turn.
 *
 * This tool replaces the chat-narrate-then-extract anti-pattern with a
 * proper synthetic gate: it pauses the plan, surfaces a text-input card
 * in the renderer, waits for the user's typed input, and resumes the
 * plan with the captured value in scratchpad.
 *
 * Routing
 * -------
 * G4's executeStep() detects `meta.isUserWaitGate === true` and routes
 * this tool through `runUserInputGate()` rather than the normal
 * tool-execution pipeline. The dispatcher in execution.ts switches on
 * tool name:
 *   - present_preview     → runPresentPreviewGate (multi-select card)
 *   - wait_for_user_ack   → runUserAckGate        (button picker)
 *   - request_user_input  → runUserInputGate      (text input)
 *
 * Skill prose contract
 * --------------------
 * After this step runs, scratchpad contains { value: "<user-typed text>" }
 * (or an empty string on timeout). Skill prose branches on whether
 * `value.length > 0` before using it. Validator-rejected timeouts return
 * empty string, NOT the rejected value.
 *
 * Returns
 * -------
 *   { value: string }
 *
 * SKILL.md authors reference this in `inputsFrom: [{ step: N, field: "value" }]`
 * for downstream steps that consume the captured text. The string is the
 * literal text the user typed, or an empty string on cancel / timeout /
 * validator rejection / aborted run. Skill prose typically branches on
 * `value.length > 0` before passing it to a downstream tool.
 *
 * Sensitive input
 * ---------------
 * When `sensitive: true`, the renderer shows a password-style masked
 * input (dots), AND the captured value is treated as a sensitive
 * parameter — redacted in audit logs, scratchpad replay, and downstream
 * tool-input logs. The skill must still declare the value as sensitive
 * at the planner level via `sensitiveParams` if it flows into a
 * downstream tool call that should also redact it.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/requestUserInput.ts
 */

import { z } from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "request_user_input",
  description:
    "Pauses the plan and captures a single free-text input from the user. " +
    "Use when the agent needs a value (email, hostname, IP, account ID, etc.) " +
    "that cannot be auto-detected and isn't covered by a button-picker " +
    "(wait_for_user_ack, max 4 options) or a multi-select card (present_preview). " +
    "Returns { value: string } — empty string on cancel/timeout. Routed " +
    "through G4's runUserInputGate; runs OUTSIDE TOOL_TIMEOUT_MS.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,

  /**
   * Marks this tool as a synthetic user-wait gate. G4 detects this and
   * routes via runUserInputGate() instead of the normal pipeline,
   * bypassing TOOL_TIMEOUT_MS and racing against USER_ACK_TIMEOUT_MS
   * (15 min default) for the user's typed input.
   */
  isUserWaitGate: true,

  outputKeys: [],
  schema: {
    prompt: z
      .string()
      .min(1)
      .describe(
        "Question shown to the user above the text-input field " +
        "(e.g. 'What's your Okta email address?').",
      ),

    placeholder: z
      .string()
      .nullable().optional()
      .describe(
        "Greyed-out hint text inside an EMPTY input. Disappears when " +
        "the user starts typing. NOT submitted as a value if the user " +
        "leaves the field blank. Use to suggest the expected format " +
        "without pre-filling text — e.g. 'alice@example.com'.",
      ),

    initialValue: z
      .string()
      .nullable().optional()
      .describe(
        "Text PRE-FILLED into the input. User can accept (click Continue) " +
        "or edit. Submitted as the captured value if the user clicks " +
        "Continue without editing. Use ONLY when the agent has a real " +
        "best-guess (e.g. partial auto-detect result). Do NOT use as a " +
        "placeholder substitute.",
      ),

    validator: z
      .string()
      .nullable().optional()
      .describe(
        "Optional regex (string source, no leading/trailing slashes) " +
        "the captured value must match before Continue enables. " +
        "Example: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' for email format. " +
        "Validation happens client-side (button disabled until match) " +
        "AND server-side at gate resolution (defense in depth). " +
        "Server-side rejection returns empty string to the scratchpad.",
      ),

    sensitive: z
      .boolean()
      .nullable().optional()
      .describe(
        "When true, the renderer shows a password-style masked input " +
        "(dots), AND the captured value is redacted in audit logs, " +
        "scratchpad replay, and consent-card previews. Use for tokens, " +
        "MFA codes, recovery keys. Do NOT use for usernames or emails " +
        "(masking those just frustrates the user when they want to " +
        "verify they typed correctly).",
      ),
  },
} as const;

// -- Stub run -----------------------------------------------------------------

/**
 * Synthetic tool — never actually invoked through the normal pipeline.
 * G4's executeStep() detects `meta.isUserWaitGate === true` and routes
 * the step through `runUserInputGate()` in execution.ts instead. This
 * stub exists only to satisfy the mcpTools registry's "every tool has
 * a run() function" invariant.
 *
 * If this throws in production, something is wrong with the gate routing
 * dispatcher — investigate `if (meta.isUserWaitGate)` in execution.ts.
 */
export async function run(): Promise<never> {
  throw new Error(
    "[request_user_input] This is a synthetic user-wait gate tool. " +
    "G4 is expected to route steps whose tool.meta.isUserWaitGate is true " +
    "through runUserInputGate() in execution.ts, NOT through the normal " +
    "tool pipeline. If you see this error, the gate routing is broken.",
  );
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  console.log(JSON.stringify({ meta: { ...meta, schema: "..." } }, null, 2));
}
