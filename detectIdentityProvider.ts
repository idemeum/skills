/**
 * mcp/skills/detectIdentityProvider.ts — detect_identity_provider
 *
 * Inspects installed agents and domain configuration to infer which
 * cloud identity provider the endpoint uses.  Returns a single canonical
 * idp ("okta" | "entra" | "google" | "unknown") plus any secondary
 * candidates and the evidence that led to the decision.
 *
 * Platform strategy
 * -----------------
 * darwin  Check for /Applications/Okta Verify.app,
 *         /Library/Application Support/JamfConnect/ (backend READ, not
 *         assumed — see detectJamfConnectDarwin),
 *         /Library/Intune/, and Google Credential Provider artefacts.
 * win32   Parse `dsregcmd /status` (for AzureAdJoined, WorkplaceJoined),
 *         registry HKLM\Software\Okta\Okta Verify, and
 *         HKLM\Software\Google\Credential Provider.
 *
 * Zero detected → return { primary: "unknown" } — never throw.
 * Multiple detected → first entry wins on `primary`; rest go in `secondary`.
 *
 * CALLERS: treat `primary` + `secondary` as an unordered set. Which IDP
 * lands in `primary` is decided purely by the hardcoded probe order in this
 * file, NOT by any notion of one IDP being more authoritative. On darwin the
 * Okta probes run first, so Entra can never be `primary` on a device that
 * also has an Okta or Jamf artefact; on win32 dsregcmd runs first, so the
 * reverse holds. A skill that branches on `primary` alone will misfire on
 * hybrid devices — test membership across both fields, as the entra-* skills
 * do.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/detectIdentityProvider.ts
 */

import * as fs from "fs";
import * as os from "os";
import { z }   from "zod";

import { isDarwin, isWin32, execAsync, runPS } from "./_shared/platform";
import type { Idp } from "./_shared/idp";
import { normalizeIdp, idpFromDiscoveryUrl } from "./_shared/idp";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "detect_identity_provider",
  description:
    "Detects which cloud identity provider (Okta, Microsoft Entra, or Google " +
    "Workspace) the endpoint is joined to. Inspects installed agents and " +
    "domain configuration, not user credentials. Returns the primary IDP plus " +
    "any secondary detections and the evidence. Use at the start of cloud " +
    "password-reset or SSO-repair workflows.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["platform","primary","secondary","evidence"],
  schema: {}, // no params
} as const;

// -- Types --------------------------------------------------------------------

interface Detection {
  idp:      Exclude<Idp, "unknown">;
  /** Short reason string — e.g. "Okta Verify installed". */
  evidence: string;
}

export interface IdpDetectionResult {
  platform:  "darwin" | "win32" | "other";
  primary:   Idp;
  secondary: Array<Exclude<Idp, "unknown">>;
  evidence:  string[];
}

// -- darwin implementation ----------------------------------------------------

async function detectDarwin(): Promise<Detection[]> {
  const detections: Detection[] = [];

  // Okta Verify — first-party Okta endpoint companion.
  if (safePathExists("/Applications/Okta Verify.app")) {
    detections.push({ idp: "okta", evidence: "Okta Verify.app installed" });
  }

  // Jamf Connect — IDP-agnostic; the backend is read, not assumed.
  detections.push(...await detectJamfConnectDarwin());

  // Intune — Microsoft-managed endpoints signal Entra.
  if (safePathExists("/Library/Intune")) {
    detections.push({ idp: "entra", evidence: "Microsoft Intune agent installed" });
  }

  // Company Portal for Entra.
  if (safePathExists("/Applications/Company Portal.app")) {
    detections.push({ idp: "entra", evidence: "Microsoft Company Portal installed" });
  }

  // Google Credential Provider / Workspace agent artefacts.
  // Google does not currently ship a Mac password-reset agent, but the
  // Workspace Endpoint Verification helper is a reasonable signal.
  if (safePathExists("/Applications/Endpoint Verification.app")) {
    detections.push({ idp: "google", evidence: "Google Endpoint Verification installed" });
  }

  // macOS Google Drive indicates Workspace but is a weak signal only —
  // do NOT return "google" solely on the basis of Google Drive.

  // Raw, NOT deduped — run() dedupes for primary/secondary and keeps this
  // list for evidence.
  return detections;
}

// -- Jamf Connect (darwin) ----------------------------------------------------

/** Jamf Connect artefacts that indicate the product is installed / configured. */
const JAMF_SUPPORT_DIR   = "/Library/Application Support/JamfConnect";
const JAMF_MANAGED_PREFS = [
  "/Library/Managed Preferences/com.jamf.connect.login",
  "/Library/Managed Preferences/com.jamf.connect",
];
/** Config-profile keys naming the backend directly. */
const JAMF_PROVIDER_KEYS  = ["OIDCProvider", "OIDCProviderName", "AuthServer"];
/** Config-profile keys naming the backend indirectly, via endpoint host. */
const JAMF_DISCOVERY_KEYS = ["OIDCDiscoveryURL", "OIDCROPGDiscoveryURL", "AuthServerURL"];

/**
 * Detect Jamf Connect and, crucially, WHICH IDP it is bound to.
 *
 * Jamf Connect replaces the macOS login window and authenticates against a
 * configurable backend — Okta, Azure/Entra, Google, OneLogin, Ping or a
 * custom OIDC endpoint. Its install path is identical in every case, so
 * presence alone carries no IDP information. This previously returned a
 * hardcoded "okta", which silently misclassified every Entra-bound fleet.
 *
 * Two independent sources, answering subtly different questions:
 *
 *   policy   `/Library/Managed Preferences/com.jamf.connect.login`
 *            The MDM-pushed config profile — what the admin has configured
 *            RIGHT NOW. Present from enrolment, before any user has logged
 *            in. Authoritative for a freshly imaged Mac, and for a tenant
 *            migration where the profile has been updated.
 *
 *   binding  `dscl . -read /Users/$USER OIDCProvider`
 *            What this user actually authenticated against at their last
 *            Jamf Connect login. Present only after a successful login, and
 *            can lag the profile after a migration.
 *
 * Both are reported when they disagree — no consumer of this tool
 * distinguishes `primary` from `secondary` (every caller tests membership
 * across both), so surfacing both is strictly safer than picking one and
 * discarding the evidence for the other.
 *
 * When Jamf Connect is present but no source is readable, falls back to the
 * historical "okta" assumption rather than dropping the detection — but says
 * so in the evidence string, so an operator reading an audit log can tell a
 * real reading from a guess.
 */
async function detectJamfConnectDarwin(): Promise<Detection[]> {
  const installed =
    safePathExists(JAMF_SUPPORT_DIR) ||
    JAMF_MANAGED_PREFS.some((d) => safePathExists(`${d}.plist`));
  if (!installed) return [];

  const policy  = await readJamfPolicyIdp();
  const binding = await readJamfBindingIdp();

  const detections: Detection[] = [];
  if (policy) {
    detections.push({
      idp:      policy.idp,
      evidence: `Jamf Connect configured for ${policy.idp} (${policy.source})`,
    });
  }
  if (binding && binding.idp !== policy?.idp) {
    detections.push({
      idp:      binding.idp,
      evidence: policy
        // Disagreement is worth spelling out — it is the migration / re-image
        // signal, and an operator seeing only one value would misread it.
        ? `Jamf Connect last login used ${binding.idp} (dscl OIDCProvider) — ` +
          `differs from the configured ${policy.idp}`
        : `Jamf Connect bound to ${binding.idp} (dscl OIDCProvider)`,
    });
  }

  if (detections.length === 0) {
    return [{
      idp:      "okta",
      evidence: "Jamf Connect present but backend not readable — assuming Okta",
    }];
  }
  return detections;
}

/** Read the MDM-pushed config profile. Returns null when unreadable. */
async function readJamfPolicyIdp(): Promise<{ idp: Exclude<Idp, "unknown">; source: string } | null> {
  for (const domain of JAMF_MANAGED_PREFS) {
    for (const key of JAMF_PROVIDER_KEYS) {
      const raw = await readDefault(domain, key);
      const idp = raw ? normalizeIdp(raw) : null;
      if (idp && idp !== "unknown") {
        return { idp, source: `${key} in managed preferences` };
      }
    }
    // OIDCProvider: Custom — the discovery endpoint is the only identifier.
    for (const key of JAMF_DISCOVERY_KEYS) {
      const raw = await readDefault(domain, key);
      const idp = raw ? idpFromDiscoveryUrl(raw) : null;
      if (idp && idp !== "unknown") {
        return { idp, source: `${key} host` };
      }
    }
  }
  return null;
}

/** Read the per-user binding written by Jamf Connect at login. */
async function readJamfBindingIdp(): Promise<{ idp: Exclude<Idp, "unknown"> } | null> {
  const user = os.userInfo().username;
  let stdout = "";
  try {
    ({ stdout } = await execAsync(
      `dscl . -read "/Users/${user}" OIDCProvider`,
      { maxBuffer: 256 * 1024, timeout: 5_000 },
    ));
  } catch {
    // Key absent (never logged in via Jamf Connect) or dscl unavailable.
    return null;
  }
  const m = stdout.match(/^OIDCProvider:\s*(\S+)\s*$/im);
  if (!m) return null;
  const idp = normalizeIdp(m[1]);
  return idp && idp !== "unknown" ? { idp } : null;
}

/**
 * `defaults read <domain-or-path> <key>` → trimmed stdout, or null on any
 * failure. `defaults` exits non-zero for a missing domain or key, which is
 * the common case here, so failures are swallowed silently.
 *
 * Domain and key are module constants — no user input is interpolated.
 */
async function readDefault(domain: string, key: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`defaults read "${domain}" "${key}"`, {
      maxBuffer: 256 * 1024, timeout: 5_000,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

// -- win32 implementation -----------------------------------------------------

async function detectWin32(): Promise<Detection[]> {
  const detections: Detection[] = [];

  // dsregcmd /status reports AzureAdJoined / WorkplaceJoined / DomainJoined.
  try {
    const { stdout } = await execAsync("dsregcmd /status", {
      maxBuffer: 2 * 1024 * 1024, timeout: 10_000,
    });
    if (/AzureAdJoined\s*:\s*YES/i.test(stdout)) {
      detections.push({ idp: "entra", evidence: "dsregcmd reports AzureAdJoined: YES" });
    } else if (/WorkplaceJoined\s*:\s*YES/i.test(stdout)) {
      detections.push({ idp: "entra", evidence: "dsregcmd reports WorkplaceJoined: YES" });
    }
  } catch {
    // dsregcmd may not be on PATH in locked-down environments; skip silently.
  }

  // Okta Verify registry key.
  if (await winRegistryKeyExists("HKLM\\Software\\Okta\\Okta Verify")) {
    detections.push({ idp: "okta", evidence: "Okta Verify installed (registry)" });
  }
  if (await winRegistryKeyExists("HKCU\\Software\\Okta\\Okta Verify")) {
    detections.push({ idp: "okta", evidence: "Okta Verify installed (registry, user hive)" });
  }

  // Google Credential Provider for Windows.
  if (await winRegistryKeyExists("HKLM\\Software\\Google\\Credential Provider")) {
    detections.push({ idp: "google", evidence: "Google Credential Provider installed" });
  }

  // Raw, NOT deduped — run() dedupes for primary/secondary and keeps this
  // list for evidence. Both HKLM and HKCU Okta keys can fire on the same
  // device; the second is dropped from the IDP set but its evidence is kept.
  return detections;
}

// -- Helpers ------------------------------------------------------------------

function safePathExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Preserve ordering but drop duplicate IDPs so each canonical value
 * appears at most once.  Used for primary/secondary only — run() builds
 * `evidence` from the PRE-dedupe list so the full trail survives.
 *
 * That distinction matters for Jamf Connect: when a device has both an
 * Okta artefact and a Jamf profile whose policy and binding disagree, the
 * duplicate dropped here is the entry explaining the disagreement. The IDP
 * set is unaffected, but an operator reading the audit log would otherwise
 * lose the only record of WHY the device reported two IDPs.
 */
function dedupeByIdp(detections: Detection[]): Detection[] {
  const seen = new Set<string>();
  const out: Detection[] = [];
  for (const d of detections) {
    if (seen.has(d.idp)) continue;
    seen.add(d.idp);
    out.push(d);
  }
  return out;
}

/**
 * Query Windows registry by firing `reg query` and checking for a
 * non-zero-length output.  Returns false on any non-zero exit or error.
 */
async function winRegistryKeyExists(key: string): Promise<boolean> {
  if (!isWin32()) return false;
  const safe = key.replace(/["'&|]/g, ""); // strip shell metacharacters
  try {
    const { stdout } = await execAsync(`reg query "${safe}"`, {
      maxBuffer: 1 * 1024 * 1024, timeout: 5_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// Exported purely for unit tests that want to fake platform detection.
export const __testing = {
  detectDarwin,
  detectWin32,
  detectJamfConnectDarwin,
};

// -- Exported run function ----------------------------------------------------

export async function run(): Promise<IdpDetectionResult> {
  let detections: Detection[] = [];
  let platform: "darwin" | "win32" | "other" = "other";

  try {
    if (isDarwin()) {
      platform = "darwin";
      detections = await detectDarwin();
    } else if (isWin32()) {
      platform = "win32";
      detections = await detectWin32();
    }
  } catch {
    // Any unexpected error falls through to the "unknown" result.
    detections = [];
  }

  if (detections.length === 0) {
    return { platform, primary: "unknown", secondary: [], evidence: [] };
  }

  // Reference runPS so the import is not flagged unused — it's listed
  // alongside execAsync in _shared/platform because win32-specific tools
  // in Phase 2 will need it.  The detection code here uses execAsync +
  // reg query directly.
  void runPS;

  // Dedupe decides the IDP set; `detections` stays raw so every signal that
  // fired is recorded. On a device with e.g. Okta Verify AND a Jamf profile
  // whose policy and binding disagree, the dropped duplicate is the entry
  // explaining the disagreement — the IDP set is unchanged but the audit
  // trail would otherwise lose the reason.
  const unique = dedupeByIdp(detections);

  const [first, ...rest] = unique;
  return {
    platform,
    primary:   first.idp,
    secondary: rest.map((d) => d.idp),
    evidence:  detections.map((d) => d.evidence),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
