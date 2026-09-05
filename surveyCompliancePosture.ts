/**
 * mcp/skills/surveyCompliancePosture.ts — survey_compliance_posture
 *
 * Coarse-grained read of the three device-compliance controls: System Integrity
 * Protection / Secure Boot, disk encryption, and the OS firewall.
 *
 * Why coarse
 * ----------
 * These are read together because they are one question — "does this device
 * still meet policy?" — and they never branch between themselves. They were
 * three plan steps, and one of them was in the wrong place entirely:
 * `check_sip_status` sat at Step 2 inside the agent-health block, because SIP
 * being disabled stops an agent starting. It is still compliance posture, and
 * grouping it here is what lets the agent block become a clean sequence.
 *
 * The fine-grained tools remain registered and are NOT deprecated.
 *
 * What it refuses to decide
 * -------------------------
 * What to do about a failure. A disabled firewall has a local remedy
 * (`enable_firewall`); disabled SIP does not — re-enabling it needs Recovery
 * Mode and is IT-controlled, so the run escalates instead. Which of those
 * applies is the skill's call.
 */

import { run as checkSipStatus }       from "./checkSipStatus";
import { run as checkFileVaultStatus } from "./checkFileVaultStatus";
import { run as checkFirewallStatus }  from "./checkFirewallStatus";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "survey_compliance_posture",
  description:
    "Reads the three device-compliance controls in one call: System Integrity " +
    "Protection (macOS) or Secure Boot (Windows), disk encryption (FileVault / " +
    "BitLocker), and the OS firewall. Read-only. Use instead of check_sip_status, " +
    "check_filevault_status and check_firewall_status separately.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["platform", "sip", "diskEncryption", "firewall"],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

export interface SurveyCompliancePostureResult {
  platform: string;
  /**
   * SIP / Secure Boot. Most security agents require it; disabled means the
   * agent may refuse to start. Not locally repairable — Recovery Mode, IT-owned.
   */
  sip: unknown;
  /** FileVault / BitLocker state and progress. */
  diskEncryption: unknown;
  /** OS firewall. The one control here with a local remedy. */
  firewall: unknown;
}

// -- Implementation -----------------------------------------------------------

export async function run(
  _args: Record<string, never> = {},
): Promise<SurveyCompliancePostureResult> {
  // Independent reads. allSettled so one failing probe leaves the other two
  // usable — each is separately actionable.
  const [sip, diskEncryption, firewall] = await Promise.allSettled([
    checkSipStatus(),
    checkFileVaultStatus(),
    checkFirewallStatus(),
  ]);

  const settled = (r: PromiseSettledResult<unknown>): unknown =>
    r.status === "fulfilled"
      ? r.value
      : { status: "error", message: String((r as PromiseRejectedResult).reason) };

  return {
    platform: process.platform,
    sip:            settled(sip),
    diskEncryption: settled(diskEncryption),
    firewall:       settled(firewall),
  };
}
