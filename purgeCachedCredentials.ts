/**
 * mcp/skills/purgeCachedCredentials.ts — purge_cached_credentials
 *
 * Removes stored credentials for specified domains from macOS Keychain
 * (login keychain) / Windows Credential Manager.  Used after a cloud
 * IDP password reset so local apps stop presenting the stale cached
 * password to the IDP.
 *
 * WILDCARD DOMAINS ARE REJECTED.  The caller must supply exact domain
 * names (e.g. "okta.com", not "*.okta.com").  Wildcard matching would
 * broaden the blast radius beyond the IDP-domain-only scope G4 and the
 * product docs promise.
 *
 * Platform strategy
 * -----------------
 * darwin  `security delete-internet-password -s <domain>` +
 *         `security delete-generic-password -s <domain>` in a loop
 *         until the exit code is non-zero (no more matching entries).
 * win32   `cmdkey /list` to enumerate; `cmdkey /delete:<target>` for
 *         each target whose name contains the domain.
 *
 * Dry-run enumerates what WOULD be deleted and returns the count and
 * sample target names — no entries are removed.
 *
 * Guardrail: high risk, destructive, requires consent, supportsDryRun,
 * affectedScope ["user"], auditRequired.
 */

import { z } from "zod";
import { isDarwin, isWin32, execAsync } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "purge_cached_credentials",
  description:
    "Removes stored credentials for specified IDP domains from macOS Keychain " +
    "(login keychain) or Windows Credential Manager. Use ONLY after the user " +
    "has confirmed a cloud IDP password reset succeeded. Each domain MUST be " +
    "an exact host match (e.g. 'okta.com') — wildcards are rejected at the " +
    "schema level to prevent broadening the blast radius.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    domains: z
      .array(
        z
          .string()
          .min(1)
          .refine(
            (v) => !/[*?]/.test(v),
            { message: "Wildcard domains are not permitted — supply exact host strings." },
          )
          .refine(
            (v) => /^[a-zA-Z0-9.\-]+$/.test(v),
            { message: "Domain must contain only letters, digits, dots and dashes." },
          ),
      )
      .min(1)
      .max(8)
      .describe("Exact domain strings whose cached credentials should be removed."),
    dryRun: z
      .boolean()
      .optional()
      .describe("When true, enumerate matching entries without deleting."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface PurgeResult {
  platform:        "darwin" | "win32" | "other";
  dryRun:          boolean;
  /** Per-domain outcome. */
  results:         Array<{
    domain:  string;
    removed: number;
    found:   number;
    sample:  string[];
    error?:  string;
  }>;
  totalRemoved:    number;
  totalFound:      number;
}

// -- darwin implementation ----------------------------------------------------

/**
 * Delete every `security`-style password entry whose server/service matches
 * the domain.  We loop invoking `security delete-internet-password -s` and
 * `security delete-generic-password -s` until both exit non-zero, which
 * indicates no remaining match.  macOS returns exit code 44 when no item
 * is found — that's the terminating condition.
 */
async function purgeDarwin(domain: string, dryRun: boolean): Promise<{
  removed: number; found: number; sample: string[]; error?: string;
}> {
  const sample: string[] = [];
  let removed = 0;
  let found   = 0;

  // Enumerate first so dry-run is informative.  `security find-internet-password
  // -s <domain> -g` prints a short block per hit; we count occurrences of
  // the "acct" field.
  try {
    const { stdout } = await execAsync(
      `security find-internet-password -s ${shellQuote(domain)} 2>&1 || true`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 5_000 },
    );
    const hits = stdout.match(/"acct"<blob>="[^"]*"/g) ?? [];
    found += hits.length;
    sample.push(...hits.slice(0, 5).map((s) => s.replace(/"acct"<blob>=/, "")));
  } catch {
    // ignore — non-zero exit means no match.
  }
  try {
    const { stdout } = await execAsync(
      `security find-generic-password -s ${shellQuote(domain)} 2>&1 || true`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 5_000 },
    );
    const hits = stdout.match(/"acct"<blob>="[^"]*"/g) ?? [];
    found += hits.length;
    sample.push(...hits.slice(0, 5).map((s) => s.replace(/"acct"<blob>=/, "")));
  } catch {
    // ignore
  }

  if (dryRun) return { removed: 0, found, sample: sample.slice(0, 10) };

  // Delete loops — exit when `security delete-*` exits non-zero.
  const MAX_ITERS = 64; // safety cap against a pathological loop
  for (let i = 0; i < MAX_ITERS; i++) {
    try {
      await execAsync(
        `security delete-internet-password -s ${shellQuote(domain)} 2>&1`,
        { maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
      );
      removed++;
    } catch {
      break;
    }
  }
  for (let i = 0; i < MAX_ITERS; i++) {
    try {
      await execAsync(
        `security delete-generic-password -s ${shellQuote(domain)} 2>&1`,
        { maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
      );
      removed++;
    } catch {
      break;
    }
  }

  return { removed, found, sample: sample.slice(0, 10) };
}

// -- win32 implementation -----------------------------------------------------

async function purgeWin32(domain: string, dryRun: boolean): Promise<{
  removed: number; found: number; sample: string[]; error?: string;
}> {
  // Enumerate — cmdkey /list prints blocks like:
  //   Target: Domain:target=xyz.okta.com
  //   Type:   Domain Password
  //   User:   user@xyz.okta.com
  let targets: string[] = [];
  try {
    const { stdout } = await execAsync(`cmdkey /list`, {
      maxBuffer: 2 * 1024 * 1024, timeout: 5_000,
    });
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*Target:\s*(.+?)\s*$/);
      if (!m) continue;
      const raw = m[1].trim();
      // "Domain:target=xyz.okta.com" or "LegacyGeneric:target=…"
      const target = raw.replace(/^[^:]+:target=/, "");
      if (target.toLowerCase().includes(domain.toLowerCase())) {
        targets.push(raw);
      }
    }
  } catch (err) {
    return { removed: 0, found: 0, sample: [], error: (err as Error).message };
  }

  const found  = targets.length;
  const sample = targets.slice(0, 10);

  if (dryRun) return { removed: 0, found, sample };

  let removed = 0;
  for (const raw of targets) {
    try {
      await execAsync(`cmdkey /delete:${shellQuoteWin(raw)}`, {
        maxBuffer: 1 * 1024 * 1024, timeout: 5_000,
      });
      removed++;
    } catch {
      // Continue on individual failures; the caller sees removed < found.
    }
  }
  return { removed, found, sample };
}

// -- Shell-escape helpers -----------------------------------------------------

function shellQuote(s: string): string {
  // Wrap in single quotes, escape any embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function shellQuoteWin(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

// Exported for unit tests.
export const __testing = { purgeDarwin, purgeWin32 };

// -- Exported run function ----------------------------------------------------

export async function run({
  domains,
  dryRun = false,
}: {
  domains: string[];
  dryRun?: boolean;
}): Promise<PurgeResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  const results: PurgeResult["results"] = [];
  let totalRemoved = 0;
  let totalFound   = 0;

  for (const domain of domains) {
    if (platform === "darwin") {
      const r = await purgeDarwin(domain, dryRun);
      results.push({ domain, ...r });
      totalRemoved += r.removed; totalFound += r.found;
    } else if (platform === "win32") {
      const r = await purgeWin32(domain, dryRun);
      results.push({ domain, ...r });
      totalRemoved += r.removed; totalFound += r.found;
    } else {
      results.push({
        domain, removed: 0, found: 0, sample: [],
        error: `Unsupported platform — cannot purge credentials.`,
      });
    }
  }

  return { platform, dryRun, results, totalRemoved, totalFound };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ domains: ["okta.com"], dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
