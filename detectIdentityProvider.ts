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
 *         /Library/Application Support/JamfConnect/,
 *         /Library/Intune/, and Google Credential Provider artefacts.
 * win32   Parse `dsregcmd /status` (for AzureAdJoined, WorkplaceJoined),
 *         registry HKLM\Software\Okta\Okta Verify, and
 *         HKLM\Software\Google\Credential Provider.
 *
 * Zero detected → return { primary: "unknown" } — never throw.
 * Multiple detected → first entry wins on `primary`; rest go in `secondary`.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/detectIdentityProvider.ts
 */

import * as fs from "fs";
import { z }   from "zod";

import { isDarwin, isWin32, execAsync, runPS } from "./_shared/platform";
import type { Idp } from "./_shared/idp";

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

  // Jamf Connect — MDM-driven Okta/Entra integration, commonly signals Okta.
  if (safePathExists("/Library/Application Support/JamfConnect")) {
    detections.push({ idp: "okta", evidence: "Jamf Connect configuration present" });
  }

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

  return dedupeByIdp(detections);
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

  return dedupeByIdp(detections);
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
 * appears at most once.  Evidence for the kept entry is the FIRST one
 * encountered — callers can still inspect result.evidence[] for the
 * full trail.
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

  const [first, ...rest] = detections;
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
