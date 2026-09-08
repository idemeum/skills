/**
 * mcp/skills/cMdmReapplyConfiguration.ts — c_mdm_reapply_configuration
 *
 * Provider-neutral corrective: tells this device to check in with its MDM and
 * re-apply the configuration it has already been assigned.
 *
 * Why it is separate from c_mdm_diagnose_configuration
 * ----------------------------------------------------
 * G4's consent gate fires per tool call, not per phase inside a tool. Folding
 * the sync into the diagnosis would force one risk level across both, so the
 * user would approve "re-apply configuration" before knowing what failed.
 * Keeping the corrective separate preserves informed consent: the diagnosis is
 * silent, the skill reports the failing profiles, then the user approves a
 * change they can see the reason for. It costs one extra step (6 -> 3, not 2).
 *
 * Scope
 * -----
 * Creates and changes NO policy. It is a re-delivery of assignments the tenant
 * already holds, and it is not a targeted re-push of a single profile — no such
 * operation exists. It completes asynchronously: success means the command was
 * accepted, not that the profile has landed. Skills MUST report that distinction
 * rather than claiming the fix is done (SKILL-AUDIT-CHECKLIST §10i).
 *
 * Not equally broad across providers. Intune re-delivers every assigned
 * configuration and compliance policy; Jamf reconciles DDM-managed declarations
 * only, because it exposes no per-device re-push for classic configuration
 * profiles. The backend is chosen from the locally probed provider, never
 * assumed — see BACKENDS below.
 *
 * UNVERIFIED against a live gateway — see c_mdm_diagnose_configuration.
 */

import { run as checkMdmEnrollment } from "./checkMdmEnrollment";
import {
  run as intuneSyncDevice,
  meta as intuneSyncMeta,
} from "./cIntuneSyncDevice";
import { run as jamfForceDdmSync } from "./cJamfForceDdmSync";

// -- Provider backends --------------------------------------------------------

/**
 * The corrective each provider offers. Mirrors the BACKENDS table in
 * c_mdm_diagnose_configuration — same providers, same match order.
 */
interface ReapplyBackend {
  matches: RegExp;
  /** Name reported back to the caller, so the skill can say what it asked. */
  label:   string;
  sync(
    args: { dryRun?: boolean },
    ctx?: { deviceSerial?: string },
  ): Promise<{
    status:         "ok" | "failed" | "not-configured";
    message:        string;
    willPost?:      boolean;
    endpoint?:      string;
    httpStatus?:    number;
    failureReason?: string;
  }>;
}

const BACKENDS: ReapplyBackend[] = [
  {
    matches: /intune|microsoft|endpoint manager/i,
    label:   "Intune",
    sync:    (args, ctx) => intuneSyncDevice(args, ctx),
  },
  {
    // Narrower than Intune's sync: this reconciles DDM-managed declarations
    // only. Jamf exposes no per-device re-push for classic configuration
    // profiles at all, so there is nothing broader to call.
    matches: /jamf/i,
    label:   "Jamf Pro",
    sync:    (args, ctx) => jamfForceDdmSync(args, ctx),
  },
];

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_mdm_reapply_configuration",
  description:
    "Tells this device to check in with its MDM and re-apply its already-assigned " +
    "configuration. Creates and changes no policy, and completes asynchronously — " +
    "success means the command was accepted, not that the profile has landed. Run " +
    "only after c_mdm_diagnose_configuration reports reapplyWarranted: true.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  auditRequired:   true,
  affectedScope:   ["network"],
  requiresDeviceSerial: true,
  sensitiveParams: [],
  outputKeys: [
    "status",
    "message",
    "provider",
    "willPost",
    "endpoint",
    "httpStatus",
    "failureReason",
  ],
  // Borrowed from the tool this wraps so the dry-run contract cannot drift.
  schema: intuneSyncMeta.schema,
} as const;

// -- Types --------------------------------------------------------------------

export interface MdmReapplyResult {
  status:         "ok" | "failed" | "not-configured";
  message:        string;
  provider?:      string;
  willPost?:      boolean;
  endpoint?:      string;
  httpStatus?:    number;
  failureReason?: string;
}

// -- Implementation -----------------------------------------------------------

export async function run(
  args: { dryRun?: boolean } = {},
  ctx?: { deviceSerial?: string; mdmProvider?: string },
): Promise<MdmReapplyResult> {
  // Fail closed on an unreadable serial rather than letting the wrapped tool
  // decide — the message here names the cause the user can act on.
  if (!ctx?.deviceSerial) {
    return {
      status:  "failed",
      message:
        "No hardware serial was resolved for this device, so the MDM cannot be " +
        "told which machine to re-apply configuration to.",
    };
  }

  // Nothing injects ctx.mdmProvider today, so this resolves it from the same
  // local probe the diagnosis uses. Defaulting to one provider was harmless
  // while only Intune was reachable; with two backends it would send an Intune
  // sync to a Jamf-managed Mac.
  const provider = ctx.mdmProvider ?? (await checkMdmEnrollment()).mdmProvider;
  const backend  = provider ? BACKENDS.find((b) => b.matches.test(provider)) : undefined;

  if (!backend) {
    return {
      status:   "failed",
      provider: provider ?? undefined,
      message: provider
        ? `This device is managed by ${provider}, which this agent cannot ` +
          "reach yet. The re-apply must be issued from the MDM console."
        : "This device's MDM provider could not be determined, so the re-apply " +
          "cannot be routed. It must be issued from the MDM console.",
    };
  }

  const r = await backend.sync(args, ctx);

  return {
    status:        r.status,
    message:       r.message,
    provider:      backend.label,
    willPost:      r.willPost,
    endpoint:      r.endpoint,
    httpStatus:    r.httpStatus,
    failureReason: r.failureReason,
  };
}
