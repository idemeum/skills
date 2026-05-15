/**
 * mcp/skills/presentPreview.ts — present_preview synthetic tool
 *
 * Like wait_for_user_ack, this is NOT a normal tool — it is a registration
 * shim for a first-class G4 gate (the "present-preview" gate) routed
 * specially in electron/agent/guards/execution.ts:executeStep().
 *
 * Why a tool at all?
 * ------------------
 * Agent plans reference tools by name. Registering present_preview in the
 * MCP tool registry lets the planner emit it as a plan step and the
 * execution LLM see its Zod schema (so it passes structured params like
 * { title, summary, categories }). But the actual `run()` below is never
 * invoked — G4 detects `meta.isUserWaitGate: true` and routes the step
 * through runPresentPreviewGate() instead of the normal tool-execution
 * pipeline.
 *
 * Why a dedicated gate (not a blocking run())?
 * --------------------------------------------
 * electron/agent/guards/execution.ts wraps every tool invocation in
 * Promise.race([skillPromise, timeoutPromise]) against TOOL_TIMEOUT_MS
 * (default 60 s). A user reading a multi-category preview and deciding
 * which boxes to keep checked can take minutes — a blocking tool run()
 * would be force-killed at 60 s and the user's eventual click would be
 * orphaned. The present-preview gate runs OUTSIDE that Promise.race with
 * its own USER_ACK_TIMEOUT_MS (default 15 min), resolving cleanly on
 * submission or on gate timeout.
 *
 * When to use
 * -----------
 * Use this in skills with the synthesis-then-confirm pattern: aggregate
 * findings from multiple diagnostic / dry-run steps, present a consolidated
 * multi-select preview, run only the categories the user keeps checked.
 *
 * Two variants:
 *   - Aggregate-then-confirm (typical) — categories' sizes / item counts /
 *     availability come from prior step outputs. The executor LLM composes
 *     the dynamic numbers from scratchpad at runtime; the planner emits
 *     the static structure (ids, labels, defaultSelected, destructive flags).
 *   - Static-option picker (rare) — categories are pre-defined choices that
 *     don't depend on prior diagnostics. The planner emits the full
 *     structure into Args; no scratchpad reads needed.
 *
 * When NOT to use
 * ---------------
 *   - Single destructive tool needing confirmation → use the existing G4
 *     consent gate (set `meta.requiresConsent: true` on the tool itself).
 *   - Single acknowledgment with no choice ("press OK to continue") → use
 *     `wait_for_user_ack`.
 *   - Routing disambiguation ("did you mean X or Y skill?") → use the
 *     Skill Router's clarification flow.
 *
 * Schema overview
 * ---------------
 * Top-level (required): title, summary, categories[] (min 1)
 * Per category (required): id (stable kebab-case), label, summary
 * Per category (optional): detail, defaultSelected (defaults true),
 *   destructive (defaults false)
 *
 * Output: { selected: string[] } — the category ids the user kept checked.
 * Empty array means cancel / dismiss / timeout / no items checked.
 *
 * Category `id` convention: short kebab-case, stable across edits, domain-
 * meaningful (not slug-of-label), unique within one call. Subsequent steps
 * reference these ids via `inputsFrom` / `When:` clauses, so they must NOT
 * be derived from `label` — label edits or localization would silently
 * break cross-step references.
 *
 * Authoring convention in SKILL.md
 * --------------------------------
 * The author writes the step body as TWO visually distinct blocks:
 *   1. A ```yaml fenced code block carrying the tool-schema fields
 *      (mirrors the Zod schema 1:1). The planner extracts this as `Args:`
 *      on the plan step.
 *   2. A "Data lineage:" prose bullet list mapping `{placeholder}` tokens
 *      to prior-step outputs. The planner extracts this as `Inputs:` on
 *      the plan step (inputsFrom).
 *
 * End-to-end disk-cleanup example (Step 9):
 *
 *   Call `present_preview` with:
 *
 *   ```yaml
 *   title: "Cleanup Plan"
 *   summary: "You can recover {totalSize} by cleaning the following:"
 *   categories:
 *     - id: large-files
 *       label: "Large files in Downloads"
 *       summary: "{N} installer files over 50 MB ({size})"
 *       defaultSelected: true
 *
 *     - id: duplicates
 *       label: "Duplicate photos & videos"
 *       summary: "{N} duplicates sorted by wasted space ({size})"
 *       defaultSelected: true
 *
 *     - id: browser-cache
 *       label: "Browser caches"
 *       summary: "Chrome, Safari, Edge — rebuild automatically ({size})"
 *       defaultSelected: true
 *
 *     - id: app-cache
 *       label: "App caches"
 *       summary: "Slack, Spotify, Discord ({size})"
 *       defaultSelected: false
 *
 *     - id: dev-cache
 *       label: "Dev caches"
 *       summary: "Xcode DerivedData, npm cache ({size})"
 *       destructive: true
 *       defaultSelected: false
 *
 *     - id: trash
 *       label: "Trash"
 *       summary: "{N} items ({size})"
 *       defaultSelected: true
 *   ```
 *
 *   Data lineage (one bullet per placeholder; executor LLM uses these
 *   to substitute tokens at runtime):
 *
 *   - top-level `{totalSize}` — sum of every category's size, formatted
 *     human-readable (e.g. "8.2 GB")
 *
 *   - inside large-files.summary:
 *     - `{N}` — `output.fileCount` from Step 3 (`get_large_files`)
 *     - `{size}` — `output.totalBytes` from Step 3, formatted
 *       human-readable
 *
 *   - inside duplicates.summary:
 *     - `{N}` — `output.duplicateGroupCount` from Step 4
 *       (`find_duplicate_files`)
 *     - `{size}` — `output.totalWastedBytes` from Step 4, formatted
 *       human-readable
 *
 *   - inside browser-cache.summary:
 *     - `{size}` — `output.totalSizeBytes` from Step 7
 *       (`clear_browser_cache` dry-run), formatted human-readable
 *
 *   - inside app-cache.summary:
 *     - `{size}` — `output.totalSizeBytes` from Step 6
 *       (`clear_app_cache` dry-run), formatted human-readable
 *
 *   - inside dev-cache.summary:
 *     - `{size}` — `output.totalSizeBytes` from Step 8
 *       (`clear_dev_cache` dry-run), formatted human-readable
 *
 *   - inside trash.summary:
 *     - `{N}` — `output.itemCount` from Step 11 (`empty_trash` dry-run)
 *     - `{size}` — `output.totalSizeBytes` from Step 11, formatted
 *       human-readable
 *
 * How the planner translates this prose:
 *   - The YAML block → emitted verbatim on the plan step's `Args:`.
 *   - The "Data lineage:" bullets → emitted on `Inputs:` (one entry per
 *     bullet, structured as `{step: N, field: "...", description: "..."}`).
 *   - At runtime, the executor LLM reads scratchpad entries named in
 *     `Inputs:`, substitutes the `{placeholder}` tokens in the YAML's
 *     summary strings, then invokes the tool with fully populated values.
 *
 * Patterns for consuming `selected`
 * ---------------------------------
 * Three patterns depending on whether the consuming step is binary,
 * iterative, or iterative-on-selection.
 *
 * Pattern A — Binary corrective step (run-or-don't):
 *   Step 10: clear_browser_cache
 *       Args:   {"browser": "all", "dryRun": false}
 *       When:   only if "browser-cache" is in Step 9's selected
 *       Inputs: selected from Step 9 (present_preview)
 *
 * Pattern B — Iterative on its own list (filtered by selection):
 *   Step 10: delete_files
 *       When:    only if "large-files" is in Step 9's selected
 *       ForEach: each file in Step 3's get_large_files output
 *       Inputs:  selected from Step 9, files from Step 3
 *
 * Pattern C — Iterative on selection itself (rare):
 *   Step 10: delete_files
 *       ForEach: each file id in Step 9's selected
 *       Inputs:  selected from Step 9 (present_preview)
 *
 * Edge cases
 * ----------
 *   - User cancels / dismisses card → tool returns { selected: [] }.
 *     Subsequent ForEach-iterated steps no-op; When: clauses depending on
 *     the selection evaluate false. The final summary explains the user
 *     opted out.
 *   - User clicks "Clean Selected" with zero items checked → same as cancel.
 *   - USER_ACK_TIMEOUT_MS (15 min) elapses → tool returns { selected: [] }.
 *   - destructive: true + defaultSelected: false on a category → renderer
 *     shows ⚠ icon and warning style; user has to explicitly opt in.
 *
 * Safety net
 * ----------
 * If G4's routing is broken or a caller invokes run() directly, the stub
 * below throws so the mistake is loud, not silently ignored.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/presentPreview.ts
 */

import { z } from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "present_preview",
  description:
    "Presents a categorised preview of pending actions to the user and " +
    "waits for their selection. Use when a SKILL.md step says 'summarise " +
    "and confirm', 'present a consolidated preview', or 'ask the user " +
    "which categories to proceed with'.\n" +
    "\n" +
    "IMPORTANT — this is a user-wait GATE, not a regular tool. G4 bypasses " +
    "the 60 s TOOL_TIMEOUT_MS ceiling for this call and instead races the " +
    "user's submission against USER_ACK_TIMEOUT_MS (default 15 min). " +
    "Returns { selected: string[] } — the category ids the user kept " +
    "checked. Empty array means cancel / dismiss / timeout / zero items.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   true,
  /**
   * The routing flag. G4's executeStep reads this and dispatches to
   * runPresentPreviewGate() — the run() below is never invoked on the
   * normal path.
   */
  isUserWaitGate:  true,
  schema: {
    title: z
      .string()
      .min(1)
      .describe(
        "Short heading shown at the top of the preview card " +
        "(e.g. 'Cleanup Plan').",
      ),
    summary: z
      .string()
      .min(1)
      .describe(
        "One-sentence framing shown under the title; typically mentions " +
        "the aggregated total recovery / impact " +
        "(e.g. 'You can recover 8.2 GB by cleaning the following:'). " +
        "Author writes the shape with {placeholder} tokens; executor LLM " +
        "substitutes runtime numbers from scratchpad before invoking.",
      ),
    categories: z
      .array(
        z.object({
          id: z
            .string()
            .min(1)
            .describe(
              "Stable kebab-case identifier returned in the gate result — " +
              "subsequent corrective steps reference this id via " +
              "inputsFrom / When: clauses. Must NOT be derived from " +
              "`label` (label edits or localization would silently break " +
              "cross-step references). Unique within one call.",
            ),
          label: z
            .string()
            .min(1)
            .describe(
              "Short user-facing name shown next to the checkbox " +
              "(e.g. 'Browser caches').",
            ),
          summary: z
            .string()
            .min(1)
            .describe(
              "One-line description rendered next to the label, typically " +
              "count + size " +
              "(e.g. 'Chrome, Safari, Edge — 1.2 GB' or " +
              "'12 installer files over 50 MB (3.4 GB)'). Author writes " +
              "the shape with {placeholder} tokens; executor LLM " +
              "substitutes runtime numbers from scratchpad.",
            ),
          detail: z
            .string()
            .optional()
            .describe(
              "Optional extra bullet text shown when the user expands the " +
              "category. Use sparingly.",
            ),
          defaultSelected: z
            .boolean()
            .optional()
            .describe(
              "Whether the checkbox is checked by default. Defaults to " +
              "true. Set false for destructive or non-obvious categories.",
            ),
          destructive: z
            .boolean()
            .optional()
            .describe(
              "When true, the renderer shows a ⚠ icon and warning style. " +
              "Combine with defaultSelected: false so the user must " +
              "explicitly opt in.",
            ),
        }),
      )
      .min(1)
      .describe(
        "Ordered list of categories the user can pick from. Min 1 entry.",
      ),
  },
} as const;

// -- Exported run function ----------------------------------------------------

/**
 * Safety-net stub. The run() function is never invoked on the normal path —
 * G4's executeStep() detects meta.isUserWaitGate and routes to
 * runPresentPreviewGate() in electron/agent/guards/execution.ts, bypassing
 * the normal tool-execution pipeline. If this throws, the routing is broken.
 */
export async function run(): Promise<never> {
  throw new Error(
    "present_preview.run() was invoked directly — this should never happen. " +
    "G4 is expected to route steps whose tool.meta.isUserWaitGate is true " +
    "through runPresentPreviewGate() in electron/agent/guards/execution.ts, " +
    "bypassing the normal tool-execution pipeline. Check G4's executeStep() " +
    "routing.",
  );
}
