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
 * UNVERIFIED against a live gateway — see c_mdm_diagnose_configuration.
 */

import {
  run as intuneSyncDevice,
  meta as intuneSyncMeta,
} from "./cIntuneSyncDevice";

/** Mirrors c_mdm_diagnose_configuration's view of what this agent can reach. */
const SUPPORTED_PROVIDER = /intune|microsoft|endpoint manager/i;

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

  // Only meaningful when a caller has already established the provider; absent
  // is normal, since the diagnosis has usually gated this.
  if (ctx.mdmProvider && !SUPPORTED_PROVIDER.test(ctx.mdmProvider)) {
    return {
      status:   "failed",
      provider: ctx.mdmProvider,
      message:
        `This device is managed by ${ctx.mdmProvider}, which this agent cannot ` +
        "reach yet. The re-apply must be issued from the MDM console.",
    };
  }

  const r = await intuneSyncDevice(args, ctx);

  return {
    status:        r.status,
    message:       r.message,
    provider:      ctx.mdmProvider ?? "Intune",
    willPost:      r.willPost,
    endpoint:      r.endpoint,
    httpStatus:    r.httpStatus,
    failureReason: r.failureReason,
  };
}
