/**
 * mcp/skills/getBrowserSsoCookiesInfo.ts — get_browser_sso_cookies_info
 *
 * Reports per-browser cookie counts matching an IDP domain without
 * modifying anything.  Read-only counterpart to `clear_browser_sso_cookies`.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getBrowserSsoCookiesInfo.ts okta.com
 *
 * NOTE: SQL predicate logic is duplicated from `clearBrowserSsoCookies.ts`
 * — keep in sync if cookie host_key matching changes.
 */

import { exec }       from "child_process";
import { promisify }  from "util";
import * as fs        from "fs";
import { z }          from "zod";

import { listCookieStores, type CookieStore, type Browser } from "./_shared/browser";
import { isDarwin } from "./_shared/platform";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_browser_sso_cookies_info",
  description:
    "Reports per-browser cookie counts matching an IDP domain without " +
    "deleting anything. Read-only counterpart to clear_browser_sso_cookies.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   [],
  schema: {
    domain: z
      .string()
      .min(1)
      .refine(
        (v) => !/[*?]/.test(v),
        { message: "Wildcard domains are not permitted — supply an exact host string." },
      )
      .refine(
        (v) => /^[a-zA-Z0-9.\-]+$/.test(v),
        { message: "Domain must contain only letters, digits, dots and dashes." },
      )
      .describe("Exact host string for the IDP domain (e.g. 'okta.com')."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface SsoCookieStoreInfo {
  browser:        Browser;
  profile:        string;
  path:           string;
  matchedCookies: number;
  skipped?:       boolean;
  error?:         string;
}

export interface GetBrowserSsoCookiesInfoResult {
  domain:        string;
  profiles:      SsoCookieStoreInfo[];
  totalMatched:  number;
  missingSqlite?: boolean;
}

// -- Helpers ------------------------------------------------------------------

async function isSqlite3OnPath(): Promise<boolean> {
  try {
    await execAsync("sqlite3 -version", { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

function buildHostPredicate(column: string, domain: string): string {
  const esc = domain.replace(/'/g, "''");
  return (
    `(${column} = '${esc}' OR ${column} = '.${esc}' ` +
    `OR ${column} LIKE '%.${esc}' OR ${column} LIKE '%.${esc}.')`
  );
}

async function sqliteCount(dbPath: string, query: string): Promise<number> {
  const { stdout } = await execAsync(
    `sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(query)}`,
    { maxBuffer: 1 * 1024 * 1024, timeout: 5_000 },
  );
  const n = parseInt(stdout.trim(), 10);
  return isNaN(n) ? 0 : n;
}

async function countSqliteStore(store: CookieStore, domain: string): Promise<SsoCookieStoreInfo> {
  const column = store.browser === "firefox" ? "host" : "host_key";
  const predicate = buildHostPredicate(column, domain);
  const countSql  = `SELECT COUNT(*) FROM cookies WHERE ${predicate};`;
  try {
    if (!fs.existsSync(store.path)) {
      return {
        browser: store.browser, profile: store.profile, path: store.path,
        matchedCookies: 0, skipped: true,
        error: "Cookies database does not exist",
      };
    }
    const matched = await sqliteCount(store.path, countSql);
    return {
      browser: store.browser, profile: store.profile, path: store.path,
      matchedCookies: matched,
    };
  } catch (err) {
    return {
      browser: store.browser, profile: store.profile, path: store.path,
      matchedCookies: 0, error: `sqlite error: ${(err as Error).message}`,
    };
  }
}

function safariUnsupported(store: CookieStore): SsoCookieStoreInfo {
  return {
    browser: store.browser, profile: store.profile, path: store.path,
    matchedCookies: 0, skipped: true,
    error: isDarwin()
      ? "Safari cookie count is unavailable in read-only mode (binary cookie format)."
      : "Safari cookie store is macOS-only.",
  };
}

// -- Exported run -------------------------------------------------------------

export async function run({
  domain,
}: { domain: string }): Promise<GetBrowserSsoCookiesInfoResult> {
  const stores = listCookieStores();
  const sqliteOk = await isSqlite3OnPath();

  const profiles: SsoCookieStoreInfo[] = [];
  let totalMatched = 0;

  for (const s of stores) {
    if (s.format === "sqlite") {
      if (!sqliteOk) {
        profiles.push({
          browser: s.browser, profile: s.profile, path: s.path,
          matchedCookies: 0, skipped: true,
          error: "sqlite3 CLI is not available on PATH — cannot count SQLite-backed cookies.",
        });
        continue;
      }
      const r = await countSqliteStore(s, domain);
      totalMatched += r.matchedCookies;
      profiles.push(r);
    } else {
      profiles.push(safariUnsupported(s));
    }
  }

  return {
    domain, profiles, totalMatched,
    missingSqlite: sqliteOk ? undefined : true,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  const domain = process.argv[2] ?? "okta.com";
  run({ domain })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
