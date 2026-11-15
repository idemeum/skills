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
 * profiles. The backend is chosen from `managedBy` (ctx.deviceManagedBy),
 * preferring the locally probed provider when both know this machine — never
 * assumed. See BACKENDS below.
 *
 * UNVERIFIED against a live gateway — see c_mdm_diagnose_configuration.
 */

import { run as checkMdmEnrollment } from "./checkMdmEnrollment";
import { z }              from "zod";
import { runCatalogTool } from "./_shared/catalogExecutor";
import { pickBackend, type DeviceToolContext } from "./_shared/deviceProviders";

// -- Provider backends --------------------------------------------------------

/**
 * The corrective each provider offers. Mirrors the BACKENDS table in
 * c_mdm_diagnose_configuration — same providers, same match order.
 */
interface ReapplyBackend {
  /** The connector this backend calls — matched against `managedBy`. */
  connectorId: string;
  matches: RegExp;
  /** Name reported back to the caller, so the skill can say what it asked. */
  label:   string;
  sync(
    args: { dryRun?: boolean },
    ctx?: DeviceToolContext,
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
    connectorId: "intune",
    matches: /intune|microsoft|endpoint manager/i,
    label:   "Intune",
    sync:    (args, ctx) => runCatalogTool("c_intune_sync_device", args, ctx) as ReturnType<ReapplyBackend["sync"]>,
  },
  {
    // Narrower than Intune's sync: this reconciles DDM-managed declarations
    // only. Jamf exposes no per-device re-push for classic configuration
    // profiles at all, so there is nothing broader to call.
    connectorId: "jamf",
    matches: /jamf/i,
    label:   "Jamf Pro",
    sync:    (args, ctx) => runCatalogTool("c_jamf_force_ddm_sync", args, ctx) as ReturnType<ReapplyBackend["sync"]>,
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
  // Changes device state: keeps G4's network-tier admin-or-MDM test.
  kind:            "corrective",
  // The planner leaves this step out when neither manages this machine.
  deviceProviders: ["intune", "jamf"],
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
  schema: {
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("When true, returns the operation preview without executing."),
  },
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
  ctx?: DeviceToolContext & { mdmProvider?: string },
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

  // The backend is one of the MDMs that know this machine (`managedBy`), never
  // a default: an Intune sync sent to a Jamf-managed Mac would address nothing.
  // The local probe only breaks a tie when both know it — the same choice the
  // diagnosis made. Nothing injects ctx.mdmProvider today.
  const provider = ctx.mdmProvider ?? (await checkMdmEnrollment()).mdmProvider;
  const ours     = provider ? BACKENDS.some((b) => b.matches.test(provider)) : false;

  // An MDM this agent has no backend for (Kandji, …) holds this machine's
  // configuration: a sync sent to another MDM would re-apply nothing.
  if (provider && !ours) {
    return {
      status:   "failed",
      provider,
      message:
        `This device is managed by ${provider}, which this agent cannot ` +
        "reach yet. The re-apply must be issued from the MDM console.",
    };
  }

  // With no provider named, act only when exactly one connected MDM knows this
  // machine — never guess between two.
  const managing = BACKENDS.filter((b) => (ctx.deviceManagedBy ?? []).includes(b.connectorId));
  const backend  = provider
    ? pickBackend(BACKENDS, ctx.deviceManagedBy, provider)
    : managing.length === 1 ? managing[0] : undefined;

  if (!backend) {
    return {
      status:   "failed",
      provider: provider ?? undefined,
      message: provider || managing.length === 0
        ? "No MDM connected to this tenant manages this device, so the re-apply " +
          "cannot be routed. It must be issued from the MDM console."
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
