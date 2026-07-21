/**
 * mcp/skills/detectIdpUsername.ts — detect_idp_username
 *
 * Phase 1 — Windows × Entra + Windows × Okta.
 * Phase 2 (this commit) — macOS × Okta Verify, macOS × Entra (Company
 *                          Portal + Intune SSO + Office license), Jamf
 *                          Connect (works across Okta / Entra / Google
 *                          IDP backends). Re-adds tccCategories:
 *                          ["FullDiskAccess"] to this tool because
 *                          some macOS probes read other apps' plists
 *                          and JSON files under ~/Library/.
 *
 * Purpose
 * -------
 * Reads the device's existing IDP-agent state to discover the user's
 * IDP login username (email / UPN).  Used by cloud-IDP password-reset
 * to auto-populate the username for `request_idemeum_idp_reset` rather
 * than asking the user via chat narration (which works poorly in
 * practice — the conversationIdRef clears on run end).
 *
 * Designed for cross-skill reuse: callers pass `idp` explicitly and
 * the tool does NOT depend on `detect_identity_provider`.  Other
 * skills (identity-auth-repair) can call this directly once they
 * know the IDP.
 *
 * Sources by platform + IDP
 * -------------------------
 * win32 + entra   `dsregcmd /status` → parse "User Name" / "Executing
 *                 Account Name" under the Diagnostic Data / SSO State
 *                 sections.  Reliable only when device is AAD-joined.
 * win32 + okta    `reg query HKCU\Software\Okta\Okta Verify /s` →
 *                 parse `UserName` REG_SZ values from each account
 *                 subkey.
 * win32 + google  Not supported.  Google Credential Provider for
 *                 Windows uses different storage.
 *
 * darwin + entra  Fallback chain (try each, collect ALL hits):
 *                 1. `defaults read com.microsoft.CompanyPortalMac`
 *                    UserPrincipalName / LastSignedInUser / UserEmail
 *                 2. `defaults read
 *                    com.microsoft.CompanyPortalMac.ssoextension`
 *                    SignedInUserUPN / lastSignedInUPN
 *                 3. `~/Library/Group Containers/UBF8T346G9.Office/
 *                    UserInfo.plist` via plutil → JSON
 *                 4. Jamf Connect probes filtered to IDP === "azure" / "entra"
 *
 * darwin + okta   Fallback chain:
 *                 1. `defaults read com.okta.OktaVerify` AccountList /
 *                    LastEnrolledUserEmail
 *                 2. `~/Library/Application Support/Okta Verify/
 *                    OktaVerifyData.json` via fs.readFile + JSON.parse
 *                 3. Jamf Connect probes filtered to IDP === "okta"
 *
 * darwin + google Fallback chain:
 *                 1. Jamf Connect probes filtered to IDP === "google"
 *                    (Google Workspace on macOS has no standalone
 *                    agent that stores the user email persistently;
 *                    Chrome / Google Workspace browser sign-in state
 *                    is not a reliable signal.)
 *
 * Jamf Connect (used across all darwin IDPs):
 *                 a. `dscl . -read /Users/$USER OIDCProvider
 *                    OIDCProviderUserName` — Jamf Connect writes the
 *                    IDP user into the local account schema once
 *                    bound. Most reliable signal, no FDA needed.
 *                 b. `defaults read com.jamf.connect.state` ADUserName /
 *                    NomadIdpUserName — Jamf Connect's user prefs.
 *                 c. `/Library/Preferences/com.jamf.connect.plist`
 *                    via plutil (system-scope, FDA-gated).
 *
 * Plist domains marked RESEARCHED below are documented in public Apple /
 * Microsoft / Okta / Jamf docs but not verified end-to-end against real
 * deployments at the time of writing. Probes use graceful empty-return
 * semantics — a wrong path degrades to "next source", never throws.
 *
 * Confidence ranking
 * ------------------
 * "high"   — direct identity-store probes (dsregcmd UPN on AAD-joined
 *            device; Okta Verify account in user-hive registry;
 *            dscl OIDCProvider on Jamf-Connect-bound macs;
 *            Company Portal UPN from defaults read).
 * "medium" — derived / secondary stores (Office license registration;
 *            Jamf Connect state plist; multi-account Okta Verify
 *            where caller must pick).
 * "low"    — speculative / partial matches (not used in Phase 1 or 2).
 *
 * Return contract
 * ---------------
 *   { primaryUsername: string | null, candidates: [...],
 *     platform, idp, reason? }
 *
 * When `primaryUsername` is null, `reason` explains why.  Callers
 * should NOT throw on unsupported combinations — null + reason is
 * the documented "I don't know" answer.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/detectIdpUsername.ts
 */

import { exec }      from "child_process";
import { promisify } from "util";
import * as os       from "os";
import { z }         from "zod";
import type { Idp }  from "./_shared/idp";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "detect_idp_username",
  description:
    "Detects the user's IDP login username (email / UPN) from on-device " +
    "IDP-agent state. Used to auto-populate username for cloud-IDP reset " +
    "flows rather than asking the user via chat. Supports Windows × " +
    "{Entra, Okta} (Phase 1) and macOS × {Entra, Okta, Google via Jamf " +
    "Connect} (Phase 2). Phase 2 macOS probes read other apps' plists / " +
    "Application Support JSON files which are gated by Full Disk Access " +
    "on macOS 14+, hence tccCategories. Returns null with a reason for " +
    "unsupported combinations — never throws.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // macOS probes read other apps' Library files (Company Portal,
  // Okta Verify, Jamf Connect state, Office license registration).
  // Some sources (dscl, defaults read of own-user prefs) don't need FDA,
  // but the FDA-gated sources are the safety net for completeness — when
  // FDA is granted all sources run; when not, FDA-required sources return
  // empty and the non-FDA sources still contribute. G4's tccPreflightCheck
  // asks for FDA once upfront rather than silently degrading mid-run.
  tccCategories:   ["FullDiskAccess"],
  outputKeys: ["primaryUsername","candidates","platform","idp","reason"],
  schema: {
    idp: z
      .enum(["okta", "entra", "google"])
      .describe(
        "IDP type to probe. Caller passes the value from " +
        "detect_identity_provider.primary (or knows it independently).",
      ),
    tenant: z
      .string()
      .nullable().optional()
      .describe(
        "Optional tenant filter — when provided and the probe finds " +
        "multiple accounts, candidates are filtered to those matching " +
        "this tenant. Useful for Okta multi-tenant setups.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface UsernameCandidate {
  username:   string;
  source:     string;
  confidence: "high" | "medium" | "low";
  tenant?:    string;
}

export interface DetectIdpUsernameResult {
  primaryUsername: string | null;
  candidates:      UsernameCandidate[];
  platform:        "darwin" | "win32" | "other";
  idp:             Idp;
  /** Populated when primaryUsername is null — explains why. */
  reason?:         string;
}

// -- Platform helper ----------------------------------------------------------

function resolvePlatform(): "darwin" | "win32" | "other" {
  const p = os.platform();
  if (p === "darwin") return "darwin";
  if (p === "win32")  return "win32";
  return "other";
}

// -- win32 + entra: dsregcmd /status -----------------------------------------

/**
 * Parse `dsregcmd /status` output for the user's UPN.
 *
 * Output format varies across Windows versions but the UPN consistently
 * appears under one of these labels:
 *   "User Name"            (Diagnostic Data / SSO State sections)
 *   "Executing Account Name"  (older Windows 10 builds)
 *   "UserPrincipalName"    (some variants)
 *
 * We try each pattern in order and return the first match. Filter out
 * MACHINE\AccountName-style values (no @ sign) — those are local
 * accounts, not UPNs.
 */
function parseDsregcmdUpn(stdout: string): string | null {
  const patterns = [
    /^\s*User Name\s*:\s*(\S+@\S+\.\S+)\s*$/im,
    /^\s*Executing Account Name\s*:\s*(\S+@\S+\.\S+)\s*$/im,
    /^\s*UserPrincipalName\s*:\s*(\S+@\S+\.\S+)\s*$/im,
  ];

  for (const re of patterns) {
    const m = stdout.match(re);
    if (m && m[1]) {
      const upn = m[1].trim();
      // Sanity check — must contain @ and a TLD-ish suffix.
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(upn)) {
        return upn;
      }
    }
  }
  return null;
}

async function probeEntraWin32(): Promise<UsernameCandidate[]> {
  let stdout = "";
  try {
    ({ stdout } = await execAsync("dsregcmd /status", {
      maxBuffer: 2 * 1024 * 1024,
      timeout:   10_000,
    }));
  } catch {
    return [];
  }

  const aadJoined        = /AzureAdJoined\s*:\s*YES/i.test(stdout);
  const workplaceJoined  = /WorkplaceJoined\s*:\s*YES/i.test(stdout);

  if (!aadJoined && !workplaceJoined) {
    return [];
  }

  const upn = parseDsregcmdUpn(stdout);
  if (!upn) return [];

  return [{
    username:   upn,
    source:     aadJoined
      ? "dsregcmd /status (AAD-joined)"
      : "dsregcmd /status (WorkplaceJoined)",
    confidence: aadJoined ? "high" : "medium",
  }];
}

// -- win32 + okta: registry probe --------------------------------------------

/**
 * Parse `reg query HKCU\Software\Okta\Okta Verify /s` output.
 *
 * Recursive registry dump format is roughly:
 *   HKEY_CURRENT_USER\Software\Okta\Okta Verify\Accounts\<id>
 *       UserName    REG_SZ    alice@example.com
 *       OrgUrl      REG_SZ    https://acme.okta.com
 *       ...
 *   HKEY_CURRENT_USER\Software\Okta\Okta Verify\Accounts\<id2>
 *       UserName    REG_SZ    bob@example.com
 *       ...
 *
 * We extract UserName + OrgUrl pairs by tracking the current key context.
 * Returns 0-N candidates depending on how many accounts are configured.
 *
 * NOTE: Exact registry layout differs across Okta Verify versions. This
 * parser is based on the documented format from Okta Verify 5.x+.
 * Verify on a real install if results look wrong.
 */
function parseOktaVerifyRegistry(stdout: string): UsernameCandidate[] {
  const candidates: UsernameCandidate[] = [];
  let currentTenant: string | undefined;
  let pendingUserName: string | undefined;

  const flush = () => {
    if (pendingUserName) {
      candidates.push({
        username:   pendingUserName,
        source:     "Okta Verify registry (HKCU)",
        confidence: "high",
        ...(currentTenant ? { tenant: currentTenant } : {}),
      });
    }
    pendingUserName = undefined;
    currentTenant   = undefined;
  };

  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    // New key — flush any pending account from the previous key.
    if (/^HKEY_(CURRENT_USER|LOCAL_MACHINE)\\/i.test(line)) {
      flush();
      continue;
    }
    // Value lines look like:  "    UserName    REG_SZ    alice@example.com"
    const userMatch = line.match(/^\s+UserName\s+REG_SZ\s+(\S+@\S+\.\S+)\s*$/i);
    if (userMatch) {
      pendingUserName = userMatch[1].trim();
      continue;
    }
    const orgMatch = line.match(/^\s+OrgUrl\s+REG_SZ\s+https?:\/\/([^/\s]+)/i);
    if (orgMatch) {
      // "acme.okta.com" → "acme"
      const host = orgMatch[1];
      const slug = host.replace(/\.okta(?:preview|-emea)?\.com$/i, "");
      if (slug && slug !== host) {
        currentTenant = slug;
      }
      continue;
    }
  }
  flush(); // final account at EOF
  return candidates;
}

async function probeOktaWin32(): Promise<UsernameCandidate[]> {
  // reg query is shell-safe — fixed key, no user input interpolation.
  // /s = recursive (subkeys + values).
  let stdout = "";
  try {
    ({ stdout } = await execAsync(
      `reg query "HKCU\\Software\\Okta\\Okta Verify" /s`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 10_000 },
    ));
  } catch {
    // Key may not exist (Okta Verify not installed / no accounts configured)
    // — return empty rather than throwing.
    return [];
  }

  return parseOktaVerifyRegistry(stdout);
}

// -- darwin shared helpers ----------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate "email-shaped" — must contain @ and a TLD-ish suffix. */
function looksLikeEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

/**
 * Run `defaults read <domain> <key>` and return the trimmed stdout, or
 * null on any failure (missing domain, missing key, parse error, etc).
 *
 * `defaults` exits non-zero when domain or key is missing — we swallow
 * those to keep probes silent.
 */
async function runDefaultsRead(
  domain: string,
  key:    string,
): Promise<string | null> {
  // `defaults read` arg-list is shell-safe (no shell interpretation; exec
  // spawns directly). Domain + key come from this file's hardcoded
  // constants — no user input interpolation.
  let stdout = "";
  try {
    ({ stdout } = await execAsync(`defaults read "${domain}" "${key}"`, {
      maxBuffer: 1 * 1024 * 1024,
      timeout:   5_000,
    }));
  } catch {
    return null;
  }
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Try each key in priority order against a single `defaults` domain.
 * First non-empty, email-shaped value wins. Returns null if nothing
 * matches.
 */
async function tryDefaultsKeys(
  domain: string,
  keys:   string[],
): Promise<string | null> {
  for (const key of keys) {
    const v = await runDefaultsRead(domain, key);
    if (v && looksLikeEmail(v)) return v.trim();
  }
  return null;
}

/**
 * Run `plutil -convert json -o - <path>` to convert a binary or XML
 * plist into JSON. Returns the parsed object, or null on failure.
 *
 * This is the FDA-gated path — when probing other apps' files under
 * ~/Library/Application Support/ or ~/Library/Group Containers/,
 * macOS 14+ requires FullDiskAccess.
 */
async function tryReadPlistAsJson(
  filePath: string,
): Promise<unknown | null> {
  let stdout = "";
  try {
    ({ stdout } = await execAsync(
      `plutil -convert json -o - "${filePath}"`,
      { maxBuffer: 4 * 1024 * 1024, timeout: 5_000 },
    ));
  } catch {
    return null;
  }
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Read a JSON file directly (no plutil intermediary). Used for Okta
 * Verify's OktaVerifyData.json which is already JSON-format on disk.
 * Returns parsed object or null on any failure.
 */
async function tryReadJsonFile(
  filePath: string,
): Promise<unknown | null> {
  try {
    const fs = await import("fs/promises");
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Recursively walk a parsed plist/JSON object collecting any string
 * value that looks like an email/UPN. Useful for probes where the key
 * name varies across versions or accounts are nested in arrays/dicts.
 */
function collectEmailsFromObject(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === "string") {
    if (looksLikeEmail(obj)) out.add(obj.trim());
    return out;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) collectEmailsFromObject(item, out);
    return out;
  }
  if (typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      collectEmailsFromObject(v, out);
    }
  }
  return out;
}

// -- darwin × entra probes ----------------------------------------------------

/**
 * Probe 1: Microsoft Company Portal user defaults.
 *
 * RESEARCHED domain `com.microsoft.CompanyPortalMac` (newer macOS builds);
 * fallback `com.microsoft.CompanyPortal` (older builds). Known keys vary
 * across Company Portal versions — try all of them.
 */
async function probeEntraCompanyPortalDarwin(): Promise<UsernameCandidate[]> {
  const keys = [
    "UserPrincipalName",
    "UPN",
    "UserEmail",
    "LastSignedInUser",
    "SignedInUser",
  ];
  const domains = [
    "com.microsoft.CompanyPortalMac",
    "com.microsoft.CompanyPortal",
  ];
  for (const domain of domains) {
    const upn = await tryDefaultsKeys(domain, keys);
    if (upn) {
      return [{
        username:   upn,
        source:     "entra-company-portal-defaults",
        confidence: "high",
      }];
    }
  }
  return [];
}

/**
 * Probe 2: Microsoft Intune SSO extension defaults.
 *
 * The Enterprise SSO Plug-in for Apple devices ships as part of Company
 * Portal and runs as a Network Extension. Its defaults store the signed-in
 * UPN under various keys across versions.
 */
async function probeEntraIntuneSsoExtensionDarwin(): Promise<UsernameCandidate[]> {
  const keys = [
    "SignedInUserUPN",
    "lastSignedInUPN",
    "PrimaryAccountUPN",
    "AccountUPN",
  ];
  const upn = await tryDefaultsKeys(
    "com.microsoft.CompanyPortalMac.ssoextension",
    keys,
  );
  if (!upn) return [];
  return [{
    username:   upn,
    source:     "entra-intune-sso-extension",
    confidence: "high",
  }];
}

/**
 * Probe 3: Microsoft Office license registration (FDA-gated).
 *
 * Office for Mac stores per-user license + identity info under
 * `~/Library/Group Containers/UBF8T346G9.Office/`. The exact file varies
 * (Licenses.plist, UserInfo.plist, LicenseRegistration.json) — we walk
 * the directory for any plist/json and collect email-shaped strings.
 *
 * Confidence is "medium" because Office stores the licensed email which
 * may differ from the user's current Entra UPN (e.g. after a tenant
 * migration the Office license can lag).
 */
async function probeEntraOfficeLicenseDarwin(): Promise<UsernameCandidate[]> {
  const home = os.homedir();
  const officeDir = `${home}/Library/Group Containers/UBF8T346G9.Office`;
  const fs = await import("fs/promises");

  // List directory contents — fail silently if missing or unreadable.
  let entries: string[] = [];
  try {
    entries = await fs.readdir(officeDir);
  } catch {
    return [];
  }

  const collected = new Set<string>();
  for (const entry of entries) {
    if (!/\.(plist|json)$/i.test(entry)) continue;
    const fullPath = `${officeDir}/${entry}`;
    const parsed = entry.endsWith(".json")
      ? await tryReadJsonFile(fullPath)
      : await tryReadPlistAsJson(fullPath);
    if (parsed !== null) collectEmailsFromObject(parsed, collected);
  }

  return [...collected].map((username) => ({
    username,
    source:     "entra-office-license",
    confidence: "medium" as const,
  }));
}

// -- darwin × okta probes -----------------------------------------------------

/**
 * Probe 1: Okta Verify user defaults.
 *
 * RESEARCHED domain `com.okta.OktaVerify` (also seen as `com.okta.mobile`
 * on newer versions). Known keys vary; the Accounts array is per-version
 * and complex, so we lean on tryDefaultsKeys for simple scalar keys first.
 */
async function probeOktaVerifyDefaultsDarwin(): Promise<UsernameCandidate[]> {
  const keys = [
    "RegisteredEmail",
    "Username",
    "LastEnrolledUserEmail",
    "PrimaryAccountEmail",
  ];
  const domains = [
    "com.okta.OktaVerify",
    "com.okta.mobile",
  ];
  for (const domain of domains) {
    const email = await tryDefaultsKeys(domain, keys);
    if (email) {
      return [{
        username:   email,
        source:     "okta-verify-defaults",
        confidence: "high",
      }];
    }
  }
  return [];
}

/**
 * Probe 2: Okta Verify on-disk Application Support data (FDA-gated).
 *
 * RESEARCHED path `~/Library/Application Support/Okta Verify/`. Files
 * vary by version (OktaVerifyData.json, accounts.json, registration.json).
 * Walk the directory + collect email-shaped strings.
 */
async function probeOktaVerifyDataDarwin(): Promise<UsernameCandidate[]> {
  const home = os.homedir();
  const oktaDir = `${home}/Library/Application Support/Okta Verify`;
  const fs = await import("fs/promises");

  let entries: string[] = [];
  try {
    entries = await fs.readdir(oktaDir);
  } catch {
    return [];
  }

  const collected = new Set<string>();
  for (const entry of entries) {
    if (!/\.(json|plist)$/i.test(entry)) continue;
    const fullPath = `${oktaDir}/${entry}`;
    const parsed = entry.endsWith(".json")
      ? await tryReadJsonFile(fullPath)
      : await tryReadPlistAsJson(fullPath);
    if (parsed !== null) collectEmailsFromObject(parsed, collected);
  }

  return [...collected].map((username) => ({
    username,
    source:     "okta-verify-data",
    confidence: "high" as const,
  }));
}

// -- darwin × Jamf Connect probes (IDP-aware) ---------------------------------

/**
 * Normalize an IDP identifier string from Jamf Connect / dscl output to
 * one of the canonical Idp enum values. Returns null for unrecognized.
 *
 * Jamf Connect reports IDP types as: "okta", "azure", "google",
 * "googleidp", "onelogin", "pingfederate", etc. dscl OIDCProvider
 * uses similar values. We only care about the three IDPs this tool
 * supports.
 */
function normalizeIdp(raw: string): Idp | null {
  const v = raw.toLowerCase().trim();
  if (v === "okta") return "okta";
  if (v === "azure" || v === "azuread" || v === "entra" || v === "entraid") return "entra";
  if (v === "google" || v === "googleidp" || v === "googleworkspace") return "google";
  return null;
}

/**
 * Probe a: `dscl . -read /Users/$USER OIDCProvider OIDCProviderUserName`.
 *
 * Jamf Connect writes the IDP user into the local account schema once
 * bound — this is the most reliable Jamf Connect signal and needs no
 * FDA. Output format:
 *   OIDCProvider: Okta
 *   OIDCProviderUserName: alice@example.com
 *
 * Filters by the requested IDP — returns empty if the Jamf-Connect-bound
 * IDP doesn't match `targetIdp`.
 */
async function probeJamfConnectDsclDarwin(
  targetIdp: Idp,
): Promise<UsernameCandidate[]> {
  const userInfo = os.userInfo();
  let stdout = "";
  try {
    ({ stdout } = await execAsync(
      `dscl . -read "/Users/${userInfo.username}" OIDCProvider OIDCProviderUserName`,
      { maxBuffer: 256 * 1024, timeout: 5_000 },
    ));
  } catch {
    return [];
  }

  const providerMatch = stdout.match(/^OIDCProvider:\s*(\S+)\s*$/im);
  const userMatch     = stdout.match(/^OIDCProviderUserName:\s*(\S+)\s*$/im);

  if (!providerMatch || !userMatch) return [];

  const providerIdp = normalizeIdp(providerMatch[1]);
  if (providerIdp !== targetIdp) return [];

  const username = userMatch[1].trim();
  if (!looksLikeEmail(username)) return [];

  return [{
    username,
    source:     "jamf-connect-dscl-oidc",
    confidence: "high",
  }];
}

/**
 * Probe b: `defaults read com.jamf.connect.state` for IDP + user.
 *
 * RESEARCHED domain — Jamf Connect's user-preferences plist. Key names
 * include ADUserName / NomadIdpUserName / IdpUser. IDP type lives in
 * keys like IdpProvider / OidcProvider / OidcDiscoveryURL.
 *
 * Filters by targetIdp — if Jamf Connect reports a different IDP backend,
 * returns empty.
 */
async function probeJamfConnectDefaultsDarwin(
  targetIdp: Idp,
): Promise<UsernameCandidate[]> {
  const domains = [
    "com.jamf.connect.state",
    "com.jamf.connect",
  ];
  const userKeys = [
    "ADUserName",
    "NomadIdpUserName",
    "IdpUser",
    "LastUser",
    "OidcUser",
  ];
  const idpKeys = [
    "IdpProvider",
    "OidcProvider",
    "OidcDiscoveryURL",
  ];

  for (const domain of domains) {
    const username = await tryDefaultsKeys(domain, userKeys);
    if (!username) continue;

    // Check IDP type — if we can't verify the IDP matches, return empty
    // rather than guess (we don't want to surface an Entra UPN when
    // caller asked for Okta).
    let idpMatches = false;
    for (const idpKey of idpKeys) {
      const idpRaw = await runDefaultsRead(domain, idpKey);
      if (!idpRaw) continue;
      const normalized = normalizeIdp(idpRaw);
      // For OidcDiscoveryURL, infer from URL host (login.microsoftonline.com
      // → entra, etc.).
      const fromUrl =
        idpKey === "OidcDiscoveryURL"
          ? idpFromDiscoveryUrl(idpRaw)
          : normalized;
      if (fromUrl === targetIdp) {
        idpMatches = true;
        break;
      }
    }
    if (!idpMatches) continue;

    return [{
      username,
      source:     "jamf-connect-defaults",
      confidence: "high",
    }];
  }
  return [];
}

/**
 * Infer IDP from an OIDC discovery URL host.
 *   https://login.microsoftonline.com/<tenant>/v2.0/... → entra
 *   https://acme.okta.com/.well-known/openid-configuration → okta
 *   https://accounts.google.com/.well-known/openid-configuration → google
 */
function idpFromDiscoveryUrl(url: string): Idp | null {
  const lower = url.toLowerCase();
  if (lower.includes("login.microsoftonline.com") || lower.includes("sts.windows.net")) {
    return "entra";
  }
  if (lower.match(/\.okta(preview|-emea)?\.com/)) return "okta";
  if (lower.includes("accounts.google.com")) return "google";
  return null;
}

/**
 * Probe c: System-scope Jamf Connect plist (FDA-gated).
 *
 * RESEARCHED path `/Library/Preferences/com.jamf.connect.plist`. Same
 * keys as the user-scope plist; walking via plutil → JSON. Useful when
 * Jamf Connect's user-scope prefs got cleared but the system-scope
 * binding is intact.
 */
async function probeJamfConnectStatePlistDarwin(
  targetIdp: Idp,
): Promise<UsernameCandidate[]> {
  const plistPath = "/Library/Preferences/com.jamf.connect.plist";
  const parsed = await tryReadPlistAsJson(plistPath);
  if (!parsed || typeof parsed !== "object") return [];

  const obj = parsed as Record<string, unknown>;
  const username =
    pickStringKey(obj, ["ADUserName", "NomadIdpUserName", "IdpUser", "LastUser", "OidcUser"]);
  if (!username || !looksLikeEmail(username)) return [];

  // IDP filter — same as the defaults probe.
  const idpRaw =
    pickStringKey(obj, ["IdpProvider", "OidcProvider"]) ??
    pickStringKey(obj, ["OidcDiscoveryURL"]);
  if (!idpRaw) return [];

  const inferredIdp =
    normalizeIdp(idpRaw) ?? idpFromDiscoveryUrl(idpRaw);
  if (inferredIdp !== targetIdp) return [];

  return [{
    username,
    source:     "jamf-connect-state-plist",
    confidence: "medium",
  }];
}

/** Return the first key from `keys` whose value in `obj` is a non-empty string. */
function pickStringKey(
  obj:  Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

// -- darwin dispatcher --------------------------------------------------------

/**
 * Run all macOS probes for the requested IDP, collecting candidates from
 * every source. Each probe is independent — one returning empty does not
 * abort the others. Final ranking is done by `selectPrimary`.
 */
async function probeDarwin(idp: Idp): Promise<UsernameCandidate[]> {
  const probes: Array<Promise<UsernameCandidate[]>> = [];

  if (idp === "entra") {
    probes.push(probeEntraCompanyPortalDarwin());
    probes.push(probeEntraIntuneSsoExtensionDarwin());
    probes.push(probeEntraOfficeLicenseDarwin());
  } else if (idp === "okta") {
    probes.push(probeOktaVerifyDefaultsDarwin());
    probes.push(probeOktaVerifyDataDarwin());
  }
  // Jamf Connect probes run for all three IDPs — they filter internally by
  // matching the bound IDP against the requested one.
  probes.push(probeJamfConnectDsclDarwin(idp));
  probes.push(probeJamfConnectDefaultsDarwin(idp));
  probes.push(probeJamfConnectStatePlistDarwin(idp));

  const results = await Promise.all(probes);
  return results.flat();
}

// -- Result builder -----------------------------------------------------------

function selectPrimary(
  candidates: UsernameCandidate[],
  tenantFilter?: string,
): UsernameCandidate | null {
  let pool = candidates;

  // Apply tenant filter when supplied — drops candidates that don't match.
  if (tenantFilter && tenantFilter.length > 0) {
    const filtered = candidates.filter(c => c.tenant === tenantFilter);
    if (filtered.length > 0) pool = filtered;
    // If filter eliminates everything, fall back to the full list — better
    // to surface SOMETHING than nothing.
  }

  if (pool.length === 0) return null;

  // Highest-confidence first; ties broken by order of discovery.
  const ranked = [...pool].sort((a, b) => {
    const rank = (c: UsernameCandidate) =>
      c.confidence === "high" ? 0 : c.confidence === "medium" ? 1 : 2;
    return rank(a) - rank(b);
  });
  return ranked[0];
}

// -- Exported run function ----------------------------------------------------

export async function run(args: {
  idp:     Idp;
  tenant?: string;
}): Promise<DetectIdpUsernameResult> {
  const platform = resolvePlatform();
  const idp      = args.idp;

  // Platform × IDP support matrix (Phase 1).
  // Each cell returns null + reason OR runs a probe.

  // darwin: Phase 2 probes (Entra / Okta / Google via Jamf Connect).
  if (platform === "darwin") {
    const candidates = await probeDarwin(idp);
    if (candidates.length === 0) {
      return {
        primaryUsername: null,
        candidates,
        platform,
        idp,
        reason:
          idp === "google"
            ? "No Jamf-Connect-bound Google identity found. Google Workspace " +
              "on macOS has no standalone agent storing the user email — " +
              "ask the user for their Google account email."
            : `No ${idp} identity found on this macOS device. The IDP-agent ` +
              `(Company Portal / Okta Verify / Jamf Connect) may not be ` +
              `installed, or Full Disk Access may be denied. Ask the user ` +
              `for their ${idp} login email.`,
      };
    }
    const primary = selectPrimary(candidates, args.tenant);
    return {
      primaryUsername: primary?.username ?? null,
      candidates,
      platform,
      idp,
      ...(primary === null
        ? { reason: "Probe found candidates but tenant filter excluded all of them." }
        : {}),
    };
  }

  // other: unsupported (Linux, etc.).
  if (platform === "other") {
    return {
      primaryUsername: null,
      candidates:      [],
      platform,
      idp,
      reason: `Platform "${os.platform()}" is not supported by this tool.`,
    };
  }

  // win32 — run the IDP-specific probe.
  let candidates: UsernameCandidate[] = [];

  if (idp === "entra") {
    candidates = await probeEntraWin32();
    if (candidates.length === 0) {
      return {
        primaryUsername: null,
        candidates,
        platform,
        idp,
        reason:
          "Device is not Azure AD-joined OR dsregcmd reported no UPN. " +
          "Ask the user for their Entra login UPN.",
      };
    }
  } else if (idp === "okta") {
    candidates = await probeOktaWin32();
    if (candidates.length === 0) {
      return {
        primaryUsername: null,
        candidates,
        platform,
        idp,
        reason:
          "Okta Verify is not installed OR no accounts are configured " +
          "in the user-hive registry. Ask the user for their Okta email.",
      };
    }
  } else {
    // google — no Phase 1 probe.
    return {
      primaryUsername: null,
      candidates:      [],
      platform,
      idp,
      reason:
        "Google Workspace IDP-username probes are not yet supported. " +
        "Ask the user for their Google account email.",
    };
  }

  // Apply tenant filter, pick primary by confidence ranking.
  const primary = selectPrimary(candidates, args.tenant);

  return {
    primaryUsername: primary?.username ?? null,
    candidates,
    platform,
    idp,
    ...(primary === null
      ? { reason: "Probe found candidates but tenant filter excluded all of them." }
      : {}),
  };
}

// Exported purely for unit tests so they can drive the parsers directly
// without spawning subprocesses.
export const __testing = {
  parseDsregcmdUpn,
  parseOktaVerifyRegistry,
  selectPrimary,
  // darwin helpers
  looksLikeEmail,
  collectEmailsFromObject,
  normalizeIdp,
  idpFromDiscoveryUrl,
  pickStringKey,
};

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "entra" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
