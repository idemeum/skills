/**
 * mcp/skills/getCachedCredentialsCount.ts — get_cached_credentials_count
 *
 * Reports per-domain cached credential counts in macOS Keychain (login)
 * or Windows Credential Manager without modifying anything.  Read-only
 * counterpart to `purge_cached_credentials`.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getCachedCredentialsCount.ts okta.com
 *
 * NOTE: enumeration logic is duplicated from `purgeCachedCredentials.ts`
 * (the dry-run "found" branch) — keep in sync if the `security` /
 * `cmdkey` enumeration commands change.
 */

import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

import { isDarwin, isWin32 } from "./_shared/platform";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_cached_credentials_count",
  description:
    "Reports per-domain cached credential counts in macOS Keychain (login) " +
    "or Windows Credential Manager without modifying anything. Read-only " +
    "counterpart to purge_cached_credentials.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   [],
  schema: {
    domains: z
      .array(z.string().min(1))
      .min(1)
      .refine(
        (arr) => arr.every((d) => !/[*?]/.test(d)),
        { message: "Wildcard domains are not permitted — supply exact host strings." },
      )
      .refine(
        (arr) => arr.every((d) => /^[a-zA-Z0-9.\-]+$/.test(d)),
        { message: "Domains must contain only letters, digits, dots and dashes." },
      )
      .describe("Exact domain strings to probe."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface DomainCredentialCount {
  domain:  string;
  count:   number;
  sample?: string[];
  error?:  string;
}

export interface GetCachedCredentialsCountResult {
  platform:    NodeJS.Platform | "other";
  domains:     DomainCredentialCount[];
  totalCount:  number;
}

// -- Helpers ------------------------------------------------------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function countDarwin(domain: string): Promise<DomainCredentialCount> {
  const sample: string[] = [];
  let count = 0;

  try {
    const { stdout } = await execAsync(
      `security find-internet-password -s ${shellQuote(domain)} 2>&1 || true`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 5_000 },
    );
    const hits = stdout.match(/"acct"<blob>="[^"]*"/g) ?? [];
    count += hits.length;
    sample.push(...hits.slice(0, 5).map((s) => s.replace(/"acct"<blob>=/, "")));
  } catch { /* no match */ }

  try {
    const { stdout } = await execAsync(
      `security find-generic-password -s ${shellQuote(domain)} 2>&1 || true`,
      { maxBuffer: 2 * 1024 * 1024, timeout: 5_000 },
    );
    const hits = stdout.match(/"acct"<blob>="[^"]*"/g) ?? [];
    count += hits.length;
    sample.push(...hits.slice(0, 5).map((s) => s.replace(/"acct"<blob>=/, "")));
  } catch { /* no match */ }

  return { domain, count, sample: sample.slice(0, 10) };
}

async function countWin32(domain: string): Promise<DomainCredentialCount> {
  try {
    const { stdout } = await execAsync(`cmdkey /list`, {
      maxBuffer: 2 * 1024 * 1024, timeout: 5_000,
    });
    const lines = stdout.split(/\r?\n/);
    const targets: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*Target:\s*(.+?)\s*$/);
      if (!m) continue;
      const raw = m[1].trim();
      const target = raw.replace(/^[^:]+:target=/, "");
      if (target.toLowerCase().includes(domain.toLowerCase())) {
        targets.push(raw);
      }
    }
    return { domain, count: targets.length, sample: targets.slice(0, 10) };
  } catch (err) {
    return { domain, count: 0, error: (err as Error).message };
  }
}

// -- Exported run -------------------------------------------------------------

export async function run({
  domains,
}: { domains: string[] }): Promise<GetCachedCredentialsCountResult> {
  const platform: "darwin" | "win32" | "other" =
    isDarwin() ? "darwin" : isWin32() ? "win32" : "other";

  const results: DomainCredentialCount[] = [];
  for (const domain of domains) {
    if (platform === "darwin") {
      results.push(await countDarwin(domain));
    } else if (platform === "win32") {
      results.push(await countWin32(domain));
    } else {
      results.push({ domain, count: 0, error: "Unsupported platform" });
    }
  }
  const totalCount = results.reduce((s, r) => s + r.count, 0);

  return { platform, domains: results, totalCount };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);
  const domains = argv.length > 0 ? argv : ["okta.com"];
  run({ domains })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
