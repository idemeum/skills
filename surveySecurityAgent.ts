/**
 * mcp/skills/surveySecurityAgent.ts — survey_security_agent
 *
 * Coarse-grained read of endpoint-agent health: which agents are installed and
 * running, their versions, and whether they are still reporting to their console.
 *
 * Why coarse
 * ----------
 * `security-agent-repair` ran seven probes before it attempted anything. Four of
 * them are one question — "is the agent alive and talking to its console?" —
 * split across `check_agent_process`, `get_agent_version` and
 * `check_agent_heartbeat`, with the version call needing a specific vendor name
 * the first call produces. That chain cost three executor iterations to gather
 * facts that never branch between themselves.
 *
 * The fine-grained tools remain registered and are NOT deprecated.
 *
 * What it decides, and what it refuses to decide
 * ----------------------------------------------
 * It resolves the vendor list and fans the per-agent version lookups out itself
 * — `get_agent_version` takes one vendor per call and rejects `"auto"`, so the
 * skill previously had to say "call it once per agent detected in Step 1". That
 * is a mechanical fan-out with one right answer.
 *
 * It does NOT decide whether to restart anything. A stopped agent with SIP
 * disabled, an unapproved extension, or a tamper-protection log entry must not
 * be restarted — the restart fails and the real blocker goes unreported. Those
 * blockers live in other probes, so only the skill can see the whole picture.
 */

import { run as checkAgentProcess }   from "./checkAgentProcess";
import { run as getAgentVersion }     from "./getAgentVersion";
import { run as checkAgentHeartbeat } from "./checkAgentHeartbeat";

/**
 * Vendors `get_agent_version` and `check_agent_heartbeat` support. An agent
 * outside this set is still reported by the process probe — it simply gets no
 * version or heartbeat, which is a gap to surface rather than an error.
 */
const SUPPORTED = new Set([
  "crowdstrike", "sentinelone", "jamf", "carbonblack", "cylance", "defender",
]);

type Vendor = "crowdstrike" | "sentinelone" | "jamf" | "carbonblack" | "cylance" | "defender";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "survey_security_agent",
  description:
    "Reads endpoint security agent health in one call: which known agents are " +
    "installed, which are running, their installed versions, and when each last " +
    "reported to its management console. Read-only. Use at the start of a " +
    "security-agent workflow instead of check_agent_process, get_agent_version " +
    "and check_agent_heartbeat separately.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // Inherited from check_agent_heartbeat, which this tool calls.
  //
  // G4's tccPreflightCheck scans the PLAN's tool metas, not what those tools
  // call internally (execution.ts — it reads meta.tccCategories per step). A
  // wrapper that omits the category silently drops the whole plan-level gate:
  // instead of blocking before any step runs and deep-linking the user to
  // System Settings, the run proceeds and fails mid-flight on a permission
  // error. Any wrapper MUST re-declare the union of what it wraps.
  tccCategories:   ["FullDiskAccess"],
  outputKeys: [
    "platform",
    "detectedAgents",
    "checkedAgents",
    "anyRunning",
    "anyDetected",
    "versions",
    "heartbeat",
    "unsupportedVendors",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

export interface SurveySecurityAgentResult {
  platform: string;
  /**
   * Agents actually PRESENT on this machine: running, or installed and stopped.
   *
   * Not what check_agent_process returns. That probes all six known vendors and
   * reports a row for each, present or not — a candidate list whose `name`
   * field made it read like a detection result. Passing it straight through
   * made `anyDetected` permanently true (see `checkedAgents`).
   */
  detectedAgents: unknown[];
  /** Every vendor probed, present or not — the input behind the conclusion. */
  checkedAgents: string[];
  anyRunning: boolean;
  /**
   * False means no KNOWN agent was found. That is a terminal finding — this
   * skill covers six vendors, and a custom EDR needs IT, not a repair attempt.
   */
  anyDetected: boolean;
  /** One entry per PRESENT supported vendor, keyed by vendor name. */
  versions: Record<string, unknown>;
  /**
   * Console reporting. Null when no supported vendor was detected — absence,
   * not a failed check.
   */
  heartbeat: unknown | null;
  /**
   * Detected agents this toolchain has no version or heartbeat support for.
   * Surface them: "console reachability not tested" is a real caveat on the
   * final report, not something to omit silently.
   */
  unsupportedVendors: string[];
}

// -- Implementation -----------------------------------------------------------

/**
 * Mirrors check_agent_process output. Its `name` is already the vendor key
 * ("crowdstrike", "defender", ...), not a display string, so it feeds
 * get_agent_version directly.
 */
interface DetectedAgent {
  name:        string;
  processName: string;
  isRunning:   boolean;
  pid:         number | null;
  platform:    string;
}

export async function run(
  _args: Record<string, never> = {},
): Promise<SurveySecurityAgentResult> {
  const proc = await checkAgentProcess({ agent: "auto" });
  const detectedAgents: DetectedAgent[] = proc.detectedAgents ?? [];

  const names = detectedAgents
    .map((a) => String(a.name ?? "").toLowerCase())
    .filter((n) => n.length > 0);

  const supported = names.filter((n) => SUPPORTED.has(n)) as Vendor[];
  const unsupportedVendors = names.filter((n) => !SUPPORTED.has(n));

  if (supported.length === 0) {
    return {
      platform: process.platform,
      // No supported vendor to look up a version for, so a stopped agent
      // cannot be evidenced — only a running one counts as present.
      detectedAgents: detectedAgents.filter((a) => a.isRunning === true),
      checkedAgents:  names,
      anyRunning:  Boolean(proc.anyRunning),
      anyDetected: detectedAgents.some((a) => a.isRunning === true),
      versions:    {},
      heartbeat:   null,
      unsupportedVendors,
    };
  }

  // get_agent_version takes one vendor per call and rejects "auto", so the
  // fan-out lives here rather than as prose telling the model to loop.
  // allSettled: one vendor's lookup failing must not blank the others.
  const [versionResults, heartbeatResult] = await Promise.all([
    Promise.allSettled(supported.map((agent) => getAgentVersion({ agent }))),
    Promise.allSettled([checkAgentHeartbeat({})]),
  ]);

  const versions: Record<string, unknown> = {};
  supported.forEach((agent, i) => {
    const r = versionResults[i]!;
    versions[agent] =
      r.status === "fulfilled"
        ? r.value
        : { status: "error", message: String(r.reason) };
  });

  const hb = heartbeatResult[0]!;

  // check_agent_process reports a row per KNOWN vendor whether or not it is
  // installed, so its list is candidates, not detections. Taking it at face
  // value made anyDetected permanently true: the skill's "no known agent —
  // advise contacting IT" exit was unreachable, every conditional keyed on
  // anyDetected walked the full repair path, and six vendor rows plus six
  // version records rode along in the scratchpad on every iteration.
  //
  // An agent is present if it is running, or if its version lookup found an
  // install on disk. Both signals were already here; only the second was
  // computed after the conclusion that needed it.
  const presentNames = new Set<string>();
  for (const a of detectedAgents) {
    const n = String(a.name ?? "").toLowerCase();
    if (!n) continue;
    if (a.isRunning === true) { presentNames.add(n); continue; }
    if ((versions[n] as { found?: unknown } | undefined)?.found === true) presentNames.add(n);
  }

  const present = detectedAgents.filter((a) =>
    presentNames.has(String(a.name ?? "").toLowerCase()),
  );

  // Carry versions only for what is present — the absent vendors' records are
  // the evidence for excluding them, and repeating six of those per iteration
  // is what made this the most expensive skill measured.
  const presentVersions: Record<string, unknown> = {};
  for (const n of presentNames) if (n in versions) presentVersions[n] = versions[n];

  return {
    platform: process.platform,
    detectedAgents: present,
    checkedAgents:  names,
    anyRunning:  Boolean(proc.anyRunning),
    anyDetected: present.length > 0,
    versions: presentVersions,
    heartbeat:
      hb.status === "fulfilled"
        ? hb.value
        : { status: "error", message: String(hb.reason) },
    unsupportedVendors,
  };
}
