/**
 * mcp/skills/recordScreen.ts — record_screen synthetic tool
 *
 * User-wait gate that lets the user record a short full-screen video mid-plan.
 * Same pattern as wait_for_user_ack: G4 detects meta.isUserWaitGate and routes
 * through a dedicated gate function instead of the normal tool-execution
 * pipeline.  The actual run() below is a safety-net stub that throws.
 *
 * When a skill includes `record_screen` in its allowed-tools and the planner
 * emits it as a step, G4 invokes `runScreenRecordingGate()` in execution.ts.
 * That function delegates to the same `createVideoRecordingPoll()` used by the
 * post-execution flow, so the UI, upload, and lifecycle are identical.
 *
 * Having record_screen in a plan's executed steps tells runtime.ts to suppress
 * the post-execution feedback-triggered recording offer — avoiding a redundant
 * second prompt.  The post-execution triage trigger is unaffected.
 */

import { z } from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "record_screen",
  description:
    "Offers the user a short full-screen recording so they can show IT the " +
    "problem.  The user controls start/stop; the recording is uploaded and " +
    "the URL is returned.  Returns { status, message, videoUrl } — status " +
    "is 'ok' on success, 'declined' when the user skips or the upload fails, " +
    "'not-configured' when recording is disabled, or 'failed' on error.\n" +
    "\n" +
    "IMPORTANT — this is a user-wait GATE, not a regular tool. G4 bypasses " +
    "the 60s TOOL_TIMEOUT_MS ceiling for this call and uses the video " +
    "recording's own timeouts (offer + recording duration + reviewing).",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  isUserWaitGate:  true,
  tccCategories:   ["ScreenRecording"],
  outputKeys:      ["status", "message", "videoUrl"],
  schema: {
    prompt: z
      .string()
      .min(1)
      .describe(
        "Short message explaining why a recording would help " +
        "(e.g. 'Record your screen to show the issue to IT').",
      ),
  },
} as const;

// -- Exported run function ----------------------------------------------------

export async function run(): Promise<never> {
  throw new Error(
    "record_screen.run() was invoked directly — this should never happen. " +
    "G4 is expected to route steps whose tool.meta.isUserWaitGate is true " +
    "through runScreenRecordingGate() in electron/agent/guards/execution.ts, " +
    "bypassing the normal tool-execution pipeline. Check G4's executeStep() routing.",
  );
}
