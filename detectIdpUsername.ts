/**
 * mcp/skills/detectIdpUsername.ts — detect_idp_username
 *
 * Phase 1 (this commit) — Windows × Entra + Windows × Okta only.
 * Phase 2 (deferred) — macOS × Okta Verify plist, Jamf Connect state,
 *                       Intune Company Portal.  Phase 2 will re-add
 *                       tccCategories: ["FullDiskAccess"] to this tool.
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
 * skills (password-reset, identity-auth-repair) can call this directly
 * once they know the IDP.
 *
 * Phase 1 sources
 * ---------------
 * win32 + entra   `dsregcmd /status` → parse "User Name" / "Executing
 *                 Account Name" under the Diagnostic Data / SSO State
 *                 sections.  Reliable only when device is AAD-joined.
 * win32 + okta    `reg query HKCU\Software\Okta\Okta Verify /s` →
 *                 parse `UserName` REG_SZ values from each account
 *                 subkey.  Reliable when Okta Verify has at least
 *                 one account configured.
 * win32 + google  Not supported in Phase 1.  Google Credential
 *                 Provider for Windows uses different storage.
 * darwin + any    Not supported in Phase 1 — deferred to Phase 2
 *                 (which will add FullDiskAccess to tccCategories).
 *
 * Confidence ranking
 * ------------------
 * "high"   — dsregcmd UPN on AAD-joined device; Okta Verify single
 *            account in user-hive registry
 * "medium" — Okta Verify with multiple accounts (caller must pick)
 * "low"    — speculative / partial matches (not used in Phase 1)
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
    "flows rather than asking the user via chat. Phase 1 supports Windows + " +
    "Entra (via dsregcmd) and Windows + Okta (via registry). macOS and " +
    "Google probes deferred to Phase 2. Returns null with a reason for " +
    "unsupported combinations — never throws.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // Phase 2 will add tccCategories: ["FullDiskAccess"] when macOS probes
  // land. Phase 1 (Windows-only) needs no TCC.
  schema: {
    idp: z
      .enum(["okta", "entra", "google"])
      .describe(
        "IDP type to probe. Caller passes the value from " +
        "detect_identity_provider.primary (or knows it independently).",
      ),
    tenant: z
      .string()
      .optional()
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

  // First check the device is actually AAD-joined — a UPN from dsregcmd on
  // a non-joined device is meaningless (could be stale state).
  const aadJoined = /AzureAdJoined\s*:\s*YES/i.test(stdout);
  if (!aadJoined) {
    return [];
  }

  const upn = parseDsregcmdUpn(stdout);
  if (!upn) return [];

  return [{
    username:   upn,
    source:     "dsregcmd /status (AAD-joined)",
    confidence: "high",
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

  // darwin: Phase 1 has no probes for any IDP.
  if (platform === "darwin") {
    return {
      primaryUsername: null,
      candidates:      [],
      platform,
      idp,
      reason:
        "macOS IDP-username probes are deferred to Phase 2. " +
        "Ask the user for their IDP login email.",
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
};

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "entra" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
