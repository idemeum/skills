/**
 * mcp/skills/waitForUserAck.ts — wait_for_user_ack synthetic tool
 *
 * This is NOT a normal tool.  It is a registration shim for a first-class
 * G4 gate — the "user-ack" gate — which is routed specially in
 * electron/agent/guards/execution.ts:executeStep().
 *
 * Why a tool at all?
 * ------------------
 * Agent plans reference tools by name.  Registering wait_for_user_ack in
 * the MCP tool registry lets the planner emit it as a plan step and the
 * execution LLM see its Zod schema (so it passes structured params like
 * { prompt, options }).  But the actual `run()` below is never invoked —
 * G4 detects `meta.isUserWaitGate: true` and routes the step through
 * runUserAckGate() instead of the normal tool-execution pipeline.
 *
 * Why a dedicated gate (not a blocking run())?
 * --------------------------------------------
 * electron/agent/guards/execution.ts:1122 wraps every tool invocation in
 * Promise.race([skillPromise, timeoutPromise]) against TOOL_TIMEOUT_MS
 * (default 60 s).  An out-of-band SSPR / cloud password reset can take
 * minutes — a blocking tool run() would be force-killed at 60 s and the
 * user's eventual click would be orphaned.  The user-ack gate runs
 * OUTSIDE that Promise.race with its own USER_ACK_TIMEOUT_MS (default
 * 15 min), resolving cleanly on choice or on gate timeout.
 *
 * Flow
 * ----
 *   1. Skill emits { tool: "wait_for_user_ack", rationale, params } as a
 *      normal plan step.
 *   2. G4 sees meta.isUserWaitGate === true and calls runUserAckGate()
 *      with { prompt, options } from params.
 *   3. runUserAckGate emits "agent:user-ack-required" IPC with the prompt
 *      + options; renderer shows UserAckCard.
 *   4. User clicks a choice → renderer calls sendUserAckResponse({ choice }).
 *   5. Gate resolves with { choice } (or { choice: "timeout" } if elapsed).
 *   6. The choice flows back to the agent's scratchpad as the tool result;
 *      the skill prose branches on "done" vs other values.
 *
 * Safety net
 * ----------
 * If G4's routing is broken or a caller invokes run() directly, the stub
 * below throws so the mistake is loud, not silently ignored.
 */

import { z } from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "wait_for_user_ack",
  description:
    "Waits for the user to confirm an out-of-band action (e.g. 'did you " +
    "finish resetting your password in the browser?'). Emits a UserAckCard " +
    "to the renderer with a prompt and clickable options; returns the " +
    "chosen option id to the agent.\n" +
    "\n" +
    "IMPORTANT — this is a user-wait GATE, not a regular tool. G4 bypasses " +
    "the 60s TOOL_TIMEOUT_MS ceiling for this call and instead races the " +
    "user's choice against USER_ACK_TIMEOUT_MS (default 15 min). Include " +
    "one option with id 'done' to proceed; other option ids (e.g. 'failed', " +
    "'cancel') should cause the skill to stop subsequent plan steps.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  /**
   * The routing flag.  G4's executeStep reads this and dispatches to
   * runUserAckGate() — the run() below is never invoked on the normal path.
   */
  isUserWaitGate:  true,
  schema: {
    prompt: z
      .string()
      .min(1)
      .describe(
        "Short question to show the user in the UserAckCard " +
        "(e.g. 'Did you complete the password reset in the browser?').",
      ),
    options: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .describe(
              "Stable identifier returned in the gate result — the agent " +
              "branches on this value. Use 'done' for the happy-path continue " +
              "option; 'failed', 'cancel', 'timeout' for the sad paths.",
            ),
          label: z
            .string()
            .min(1)
            .describe("Human-readable button text shown in the UserAckCard."),
          kind: z
            .enum(["primary", "secondary", "cancel"])
            .optional()
            .describe(
              "Optional visual hint for the button (primary = green/emerald, " +
              "secondary = neutral zinc, cancel = muted). Defaults to 'secondary'.",
            ),
        }),
      )
      .min(1)
      .max(4)
      .describe(
        "Ordered list of clickable options. Include one 'done' option on " +
        "the happy path plus 1-3 sad-path options.",
      ),
  },
} as const;

// -- Exported run function ----------------------------------------------------

/**
 * Safety-net stub.  The run() function is never invoked on the normal path —
 * G4's executeStep() detects meta.isUserWaitGate and routes to runUserAckGate()
 * before the tool-execution block.  If this throws, the routing is broken.
 */
export async function run(): Promise<never> {
  throw new Error(
    "wait_for_user_ack.run() was invoked directly — this should never happen. " +
    "G4 is expected to route steps whose tool.meta.isUserWaitGate is true " +
    "through runUserAckGate() in electron/agent/guards/execution.ts, bypassing " +
    "the normal tool-execution pipeline. Check G4's executeStep() routing.",
  );
}
