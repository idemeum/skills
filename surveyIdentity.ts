/**
 * mcp/skills/surveyIdentity.ts — survey_identity
 *
 * Coarse-grained read of the four local causes of an authentication failure:
 * clock drift, Kerberos tickets, client certificates, and AD/domain binding.
 *
 * Why coarse
 * ----------
 * `identity-auth-repair` exists because these four faults present identically —
 * "Outlook and Teams and VPN are all broken at once" — so the skill runs all
 * four probes unconditionally before it can say anything at all. Four plan steps
 * meant four executor iterations, each re-sending the plan, the tool schemas and
 * the whole scratchpad, to reach a conclusion no single probe could give.
 *
 * They are also independent, so running them concurrently makes the survey cost
 * roughly the slowest one rather than their sum.
 *
 * The fine-grained tools remain registered and are NOT deprecated.
 *
 * What it refuses to decide
 * -------------------------
 * Which fault is the root cause. NTP drift over five minutes breaks Kerberos,
 * SAML and TOTP simultaneously, so a drifted clock *and* an expired ticket is
 * one fault, not two — and saying so is a judgement the skill makes from these
 * fields. This tool reports; the prose diagnoses.
 */

import { run as checkNtpStatus }         from "./checkNtpStatus";
import {
  run as checkKerberosTicket,
  meta as kerberosMeta,
} from "./checkKerberosTicket";
import {
  run as listClientCertificates,
  meta as certsMeta,
} from "./listClientCertificates";
import { run as checkAdBinding }         from "./checkAdBinding";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "survey_identity",
  description:
    "Reads the four local causes of authentication failure in one call: system " +
    "clock drift against a reference NTP source, Kerberos ticket state, client " +
    "certificate expiry, and Active Directory / domain binding. Read-only. Use " +
    "at the start of an authentication workflow instead of check_ntp_status, " +
    "check_kerberos_ticket, list_client_certificates and check_ad_binding " +
    "separately.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["platform", "ntp", "kerberos", "certificates", "adBinding"],
  // Borrowed from the tools this one calls so the thresholds cannot drift.
  schema: {
    expiryWarnMinutes: kerberosMeta.schema.expiryWarnMinutes,
    expiryWarnDays:    certsMeta.schema.expiryWarnDays,
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface SurveyIdentityResult {
  platform: string;
  /** Clock offset against a reference source. `status: "drifted"` is root cause #1. */
  ntp:          unknown;
  /** Active TGTs and service tickets, with expiry flags. */
  kerberos:     unknown;
  /** Personal / machine client certificates and their expiry status. */
  certificates: unknown;
  /**
   * Domain binding. Safe to read everywhere — on Entra-joined and non-domain
   * machines it cleanly reports "not domain-joined" rather than erroring, which
   * is what tells you whether a missing Kerberos ticket matters at all.
   */
  adBinding:    unknown;
}

// -- Implementation -----------------------------------------------------------

export async function run(
  args: { expiryWarnMinutes?: number; expiryWarnDays?: number } = {},
): Promise<SurveyIdentityResult> {
  // Independent probes — concurrency makes the survey cost the slowest, not the
  // sum. allSettled rather than all: one probe failing (a wedged `klist`, a
  // keychain the user has locked) must not blank the other three, because any
  // one of them can be the whole answer.
  const [ntp, kerberos, certificates, adBinding] = await Promise.allSettled([
    checkNtpStatus({}),
    checkKerberosTicket({ expiryWarnMinutes: args.expiryWarnMinutes ?? 60 }),
    listClientCertificates({ expiryWarnDays: args.expiryWarnDays ?? 30 }),
    checkAdBinding(),
  ]);

  const settled = (r: PromiseSettledResult<unknown>): unknown =>
    r.status === "fulfilled"
      ? r.value
      : { status: "error", message: String((r as PromiseRejectedResult).reason) };

  return {
    platform: process.platform,
    ntp:          settled(ntp),
    kerberos:     settled(kerberos),
    certificates: settled(certificates),
    adBinding:    settled(adBinding),
  };
}
