/**
 * mcp/skills/cMdmDiagnoseConfiguration.ts — c_mdm_diagnose_configuration
 *
 * Provider-neutral, read-only MDM diagnosis. Collapses three SKILL.md steps —
 * `check_mdm_enrollment` → find device → read per-item states — into one call,
 * dispatching to a per-provider backend (`BACKENDS`) chosen from the locally
 * probed `mdmProvider`. Intune and Jamf are wired; the skills never name either.
 *
 * Naming
 * ------
 * `c_` because this can leave the machine, which is the boundary that prefix
 * marks: `sync-skills-tools-payload.js` filters `tools-schema.json` on it, so a
 * gateway tool named otherwise would leak into the local-tool schema. NOT
 * `survey_*` for the same reason — every `survey_*` tool is a cheap local read.
 * The middle segment is `mdm`, not a vendor, because Jamf dispatch belongs
 * inside this file rather than in four SKILL.md rewrites.
 *
 * Why it exists
 * -------------
 * Those three steps, and the rules chaining them, were written out in prose in
 * `network-reset`, `identity-auth-repair`, `vpn-repair` and
 * `security-agent-repair` — four copies. Worse, the rules themselves ("continue
 * ONLY when matchCount is exactly 1", "skip when lastCheckIn is more than 7 days
 * ago", "only `failed` warrants a sync") were English re-evaluated by the
 * executor LLM on every iteration. That is the class of condition that misfired
 * twice on 2026-09-01, running an Intune arm on an unmanaged Mac. Here they are
 * code, and testable.
 *
 * UNVERIFIED against a live gateway. No gateway has ever answered one of these
 * calls, so the response shapes below are inferred from `intune.yaml` and
 * `jamf.yaml`. That risk already existed across four SKILL.md arms; consolidating
 * it here means the eventual correction is one file rather than four.
 *
 * The two providers are not symmetric, and the asymmetry is deliberately visible
 * rather than smoothed over: Jamf reports failed MDM *commands* instead of
 * per-profile states, so it can say what broke but not what is healthy
 * (`itemsComplete: false`), and it has no compliance-policy model at all
 * (`state-set-unsupported`).
 *
 * What deliberately stays with the LLM
 * ------------------------------------
 * Semantic relevance. This reports which profiles or policies are in `failed`
 * state; it does NOT decide whether a profile named "Corporate Wi-Fi" explains
 * the fault the skill diagnosed. Mechanical gates in code, judgement about
 * meaning in the prose.
 */

import { run as checkMdmEnrollment }        from "./checkMdmEnrollment";
import { run as intuneFindDevice }          from "./cIntuneFindDevice";
import { run as intuneGetConfigStates }     from "./cIntuneGetConfigurationStates";
import { run as intuneGetComplianceStates } from "./cIntuneGetComplianceStates";
import { run as jamfFindDevice }            from "./cJamfFindDevice";
import { run as jamfGetFailedCommands }     from "./cJamfGetFailedCommands";
import { z }                                from "zod";

// -- Rules, as constants ------------------------------------------------------

/**
 * A device that has not contacted its MDM in this long is not collecting policy
 * at all, so a re-apply would sit unacknowledged and the user's wait would be
 * spent for nothing. The stale date is the finding worth escalating: it says the
 * device fell off management, not that a profile is wrong.
 */
const STALE_CHECKIN_DAYS = 7;

/**
 * The only state a re-apply can act on.
 *
 *   pending / deferred — the device already has the command and has not
 *                        finished; re-applying just re-queues it.
 *   conflict          — two policies disagree; IT must resolve, a sync cannot.
 *   applied           — it landed, so the fault lies elsewhere.
 */
const ACTIONABLE_STATE = "failed";

// -- Provider backends --------------------------------------------------------

/** The neutral device record every backend must produce. */
interface BackendDevice {
  status:           "ok" | "failed" | "not-configured";
  message:          string;
  matchCount?:      number;
  deviceName?:      string;
  deviceId?:        string;
  /** Intune only. Jamf has no equivalent and nothing branches on it. */
  complianceState?: string;
  lastCheckIn?:     string;
}

/** The neutral per-item state set every backend must produce. */
interface BackendStates {
  status:  "ok" | "failed" | "not-configured";
  message: string;
  states?: { name: string; state: string; stateReason: string | null }[];
}

interface MdmBackend {
  /** Tested against the locally probed `mdmProvider` string. */
  matches: RegExp;
  findDevice(ctx?: { deviceSerial?: string }): Promise<BackendDevice>;
  /**
   * Null when this provider cannot report the requested set at all — the run
   * ends in `state-set-unsupported` rather than pretending an empty result.
   */
  getStates(
    which: "configuration" | "compliance",
    ctx?: { deviceSerial?: string },
  ): Promise<BackendStates> | null;
  /**
   * Whether `getStates` returns every assigned item or only the failures.
   *
   * Load-bearing for `items`: `identity-auth-repair` and `vpn-repair` reason
   * about *absence* ("is a certificate profile assigned at all?"), which is only
   * valid when the list is complete. Surfaced to callers as `itemsComplete`.
   */
  reportsAllItems: boolean;
}

/**
 * Jamf reports failed MDM *commands*, not profile states, and the command log
 * spans far more than profiles — restarts, lock attempts, inventory queries.
 * Without this filter an unrelated command failure would be reported as a
 * configuration fault.
 */
const JAMF_PROFILE_COMMANDS = /^(install|remove)profile$/i;

const BACKENDS: MdmBackend[] = [
  {
    matches: /intune|microsoft|endpoint manager/i,
    findDevice: (ctx) => intuneFindDevice({}, ctx),
    getStates: (which, ctx) =>
      which === "compliance"
        ? intuneGetComplianceStates({}, ctx)
        : intuneGetConfigStates({}, ctx),
    reportsAllItems: true,
  },
  {
    matches: /jamf/i,
    findDevice: async (ctx) => {
      const r = await jamfFindDevice({}, ctx);
      if (r.status !== "ok") return { status: r.status, message: r.message };
      return {
        status:      "ok",
        message:     r.message,
        matchCount:  r.matchCount,
        deviceName:  r.name ?? undefined,
        deviceId:    r.id ?? undefined,
        lastCheckIn: r.lastContactTime ?? undefined,
        // complianceState deliberately absent — Jamf exposes no equivalent, and
        // synthesising one from `supervised` / `mdmCapable` would invent a
        // judgement the tenant never made.
      };
    },
    getStates: (which, ctx) => {
      // Jamf has no compliance-policy model; compliance is expressed through
      // smart groups, which is a different shape entirely.
      if (which === "compliance") return null;
      return (async (): Promise<BackendStates> => {
        const r = await jamfGetFailedCommands({}, ctx);
        if (r.status !== "ok") return { status: r.status, message: r.message };
        return {
          status:  "ok",
          message: r.message,
          states: (r.commands ?? [])
            .filter((c) => JAMF_PROFILE_COMMANDS.test(c.commandType))
            // Jamf carries no display name on a command — only the type. The
            // profileId that would resolve one is not returned by this endpoint.
            .map((c) => ({
              name:        c.commandType,
              state:       ACTIONABLE_STATE,
              stateReason: c.commandError,
            })),
        };
      })();
    },
    // The endpoint returns only ERROR commands, so a healthy device yields an
    // empty list that says nothing about how many profiles are assigned.
    reportsAllItems: false,
  },
];

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_mdm_diagnose_configuration",
  description:
    "Read-only MDM check: reports whether this device is managed, whether it is " +
    "reachable in the MDM tenant, when it last checked in, and which configuration " +
    "profiles (or compliance policies) are in a failed state. Makes no changes. " +
    "Run before proposing an MDM re-apply, and report its outcome when no " +
    "re-apply is warranted.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  // Subject is this endpoint's hardware serial, injected by G4 as
  // ToolRunContext.deviceSerial — never a parameter. See CLAUDE.md
  // § meta.requiresDeviceSerial.
  requiresDeviceSerial: true,
  sensitiveParams: [],
  outputKeys: [
    "outcome",
    "message",
    "isEnrolled",
    "mdmProvider",
    "serialNumber",
    "deviceName",
    "deviceId",
    "complianceState",
    "lastCheckIn",
    "daysSinceCheckIn",
    "matchCount",
    "failedItems",
    "items",
    "itemCount",
    "itemsComplete",
    "reapplyWarranted",
  ],
  schema: {
    states: z
      .enum(["configuration", "compliance"])
      .nullable().optional()
      .describe(
        "Which state set to read. 'configuration' (default) returns configuration " +
        "profiles — Wi-Fi, proxy, VPN, certificate payloads. 'compliance' returns " +
        "compliance policies — encryption, firewall, OS version, agent presence. " +
        "security-agent-repair wants 'compliance'; the network and identity " +
        "workflows want 'configuration'.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

/**
 * Every terminal state this tool can reach. Exhaustive by design: the skill
 * reports the outcome it gets rather than re-deriving it from raw fields, so a
 * new state here can never be silently misread as one of the old ones.
 */
export type MdmDiagnoseOutcome =
  | "not-enrolled"       // no MDM at all
  | "other-provider"     // managed, but not by a provider we can reach
  | "serial-unreadable"  // enrolled, but no usable hardware serial (common on VMs)
  | "not-configured"     // gateway URL or API key absent on this machine
  | "lookup-failed"      // gateway reachable but the call failed
  | "not-found"          // serial not present in the tenant
  | "ambiguous-serial"   // more than one device shares this serial
  | "stale-checkin"      // device has not collected policy recently
  | "state-set-unsupported" // provider reachable, but cannot report this set
  | "no-failed-items"    // reachable and current, nothing in failed state
  | "failed-items";      // actionable: at least one profile or policy failed

export interface MdmStateItem {
  name:        string;
  state:       string;
  stateReason: string | null;
}

export interface MdmDiagnoseResult {
  outcome:           MdmDiagnoseOutcome;
  message:           string;
  isEnrolled:        boolean;
  mdmProvider:       string | null;
  serialNumber:      string | null;
  deviceName?:       string;
  deviceId?:         string;
  complianceState?:  string;
  lastCheckIn?:      string;
  daysSinceCheckIn?: number | null;
  matchCount?:       number;
  /** Only the entries in `failed` state — what a re-apply could act on. */
  failedItems:       MdmStateItem[];
  /**
   * Every entry the tenant reports, whatever its state.
   *
   * Carried alongside `failedItems` because "is a certificate profile assigned
   * at all?" is a different question from "did one fail" — an estate that issues
   * client certs outside MDM has no such profile, and that absence is itself the
   * finding worth escalating. `identity-auth-repair` and `vpn-repair` depend on it.
   */
  items:             MdmStateItem[];
  itemCount?:        number;
  /**
   * Whether `items` lists every assigned item or only the failures.
   *
   * False on a provider that exposes failures alone (Jamf), where an empty
   * `items` means "nothing failed", NOT "nothing is assigned". Any skill that
   * reasons about absence — identity-auth-repair and vpn-repair both do — must
   * check this before concluding a profile is missing.
   */
  itemsComplete?:    boolean;
  /**
   * The single field a re-apply step should gate on. True only when a re-apply
   * could actually change something: exactly one device, checked in recently, at
   * least one item in `failed`.
   */
  reapplyWarranted:  boolean;
}

// -- Helpers ------------------------------------------------------------------

/**
 * Whole days since an ISO timestamp. Returns null for a missing or unparseable
 * date — the caller treats that as "cannot tell", never as fresh, because
 * assuming freshness is what sends the user into a pointless wait.
 */
export function daysSince(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

function base(
  outcome: MdmDiagnoseOutcome,
  message: string,
  fields: Partial<MdmDiagnoseResult> = {},
): MdmDiagnoseResult {
  return {
    outcome,
    message,
    isEnrolled:       false,
    mdmProvider:      null,
    serialNumber:     null,
    failedItems:      [],
    items:            [],
    reapplyWarranted: false,
    ...fields,
  };
}

// -- Implementation -----------------------------------------------------------

export async function run(
  args: { states?: "configuration" | "compliance" | null } = {},
  ctx?: { deviceSerial?: string },
): Promise<MdmDiagnoseResult> {
  const which = args.states ?? "configuration";
  const noun  = which === "compliance" ? "compliance policy" : "configuration profile";

  // ── 1. Local enrollment probe ────────────────────────────────────────────
  // First and unconditional: on an unmanaged machine this is the whole answer,
  // and it costs no network call.
  const enrollment = await checkMdmEnrollment();

  if (!enrollment.isEnrolled) {
    return base(
      "not-enrolled",
      "This device is not enrolled in any MDM, so there is no managed " +
      "configuration to inspect or re-apply.",
      { serialNumber: enrollment.serialNumber },
    );
  }

  const provider = enrollment.mdmProvider;
  const backend  = provider ? BACKENDS.find((b) => b.matches.test(provider)) : undefined;
  if (!backend) {
    return base(
      "other-provider",
      `This device is managed by ${provider ?? "an unidentified provider"}, ` +
      "which this agent cannot reach yet. Its configuration must be checked " +
      "from the MDM console.",
      { isEnrolled: true, mdmProvider: provider, serialNumber: enrollment.serialNumber },
    );
  }

  // G4 resolves the serial once per process and injects it here. Absent means
  // the hardware read failed or returned an OEM placeholder — acting on that
  // would address whichever device the tenant matched first.
  if (!ctx?.deviceSerial) {
    return base(
      "serial-unreadable",
      "This device is MDM-managed but its hardware serial could not be read, " +
      "so it cannot be located in the tenant. Common on virtual machines.",
      { isEnrolled: true, mdmProvider: provider, serialNumber: null },
    );
  }

  const common = { isEnrolled: true, mdmProvider: provider, serialNumber: ctx.deviceSerial };

  // ── 2. Locate the device in the tenant ───────────────────────────────────
  const found = await backend.findDevice(ctx);

  if (found.status === "not-configured") return base("not-configured", found.message, common);
  if (found.status !== "ok") {
    return base("lookup-failed", `Could not look up this device in the MDM tenant: ${found.message}`, common);
  }

  // Serials are not unique — VM templates and some OEM batches ship duplicates,
  // so a single returned record may describe a different machine. Act on none.
  const matchCount = found.matchCount ?? 0;
  if (matchCount === 0) {
    return base(
      "not-found",
      "This device's serial is not present in the MDM tenant. It may be " +
      "enrolled elsewhere, or its record may have been removed.",
      { ...common, matchCount },
    );
  }
  if (matchCount > 1) {
    return base(
      "ambiguous-serial",
      `${matchCount} devices in the tenant share this serial, so the record ` +
      "returned may be a different machine. IT must identify the right one " +
      "before anything is re-applied.",
      { ...common, matchCount },
    );
  }

  const withDevice = {
    ...common,
    matchCount,
    deviceName:      found.deviceName,
    deviceId:        found.deviceId,
    complianceState: found.complianceState,
    lastCheckIn:     found.lastCheckIn,
  };

  const age = daysSince(found.lastCheckIn);
  if (age === null || age > STALE_CHECKIN_DAYS) {
    return base(
      "stale-checkin",
      age === null
        ? "The MDM tenant did not report a usable last check-in date for this " +
          "device, so there is no evidence it is still collecting policy."
        : `This device last contacted the MDM ${age} days ago, so it is not ` +
          "collecting policy. Re-applying configuration would sit unacknowledged.",
      { ...withDevice, daysSinceCheckIn: age },
    );
  }

  // ── 3. Per-item states ───────────────────────────────────────────────────
  const pending = backend.getStates(which, ctx);
  if (pending === null) {
    return base(
      "state-set-unsupported",
      `${provider} does not report ${noun} states in a form this agent can read, ` +
      "so this check cannot be completed from here. It must be run from the MDM console.",
      { ...withDevice, daysSinceCheckIn: age },
    );
  }
  const states = await pending;

  if (states.status === "not-configured") {
    return base("not-configured", states.message, { ...withDevice, daysSinceCheckIn: age });
  }
  if (states.status !== "ok") {
    return base(
      "lookup-failed",
      `Located the device but could not read its ${noun} states: ${states.message}`,
      { ...withDevice, daysSinceCheckIn: age },
    );
  }

  const toItem = (s: { name: string; state: string; stateReason: string | null }): MdmStateItem =>
    ({ name: s.name, state: s.state, stateReason: s.stateReason });

  const items  = (states.states ?? []).map(toItem);
  const failed = items.filter((s) => s.state === ACTIONABLE_STATE);

  if (failed.length === 0) {
    return base(
      "no-failed-items",
      backend.reportsAllItems
        ? `All ${items.length} ${noun}(s) on this device are in a non-failed state, ` +
          "so re-applying them would change nothing."
        // A failures-only provider cannot make the stronger claim: no failures
        // is not evidence that anything is assigned, let alone healthy.
        : `No failed ${noun}(s) are recorded for this device, so a re-apply has ` +
          `nothing to act on. ${provider} reports only failures, so this does ` +
          "not confirm that every profile is present and applied.",
      {
        ...withDevice,
        daysSinceCheckIn: age,
        items,
        itemCount:     items.length,
        itemsComplete: backend.reportsAllItems,
      },
    );
  }

  return {
    ...base("failed-items", "", { ...withDevice, daysSinceCheckIn: age }),
    message:
      `${failed.length} ${noun}(s) failed to apply on this device: ` +
      `${failed.map((f) => f.name).join(", ")}.`,
    failedItems:      failed,
    items,
    itemCount:        items.length,
    itemsComplete:    backend.reportsAllItems,
    reapplyWarranted: true,
  };
}
