/**
 * mcp/skills/clearBrowserSsoCookies.ts — clear_browser_sso_cookies
 *
 * Targeted cookie deletion for a single IDP domain across Chrome, Edge,
 * Safari, and Firefox.  Scope is strictly limited to cookies whose host
 * matches or is a sub-domain of the supplied domain — all other site
 * logins are preserved.
 *
 * Platform strategy
 * -----------------
 * Chromium (Chrome/Edge):
 *   Cookies live in a SQLite DB.  We issue:
 *     DELETE FROM cookies WHERE host_key = '.<domain>' OR host_key = '<domain>'
 *                            OR host_key LIKE '%.<domain>' OR host_key LIKE '%.<domain>.'
 *   No decryption required — the host_key column is plain-text.
 *   Must be called while the browser process is closed; otherwise the
 *   in-memory cookie jar will rewrite the SQLite file on shutdown and
 *   lose our delete.  We do NOT attempt to close the browser — the dry-
 *   run surface reports counts so the consent gate shows the user which
 *   browsers they need to quit first.
 *
 * Safari (macOS only):
 *   Cookies.binarycookies is a proprietary binary format.  We shell out
 *   to AppleScript via osascript to tell Safari to delete cookies for
 *   the IDP domain through its own API.  Requires Safari to be running
 *   or launchable.
 *
 * Firefox:
 *   Per-profile cookies.sqlite.  Same SQL pattern as Chromium.
 *
 * All SQLite ops go through `sqlite3` as a subprocess so we don't need
 * to bundle better-sqlite3 into the skill build.  If `sqlite3` is not
 * on PATH, the entry is skipped with an "unavailable" error; the user's
 * consent card still shows every cookie that would have been cleared on
 * other browsers.
 */

import { z }   from "zod";
import * as fs from "fs";

import { execAsync, isDarwin }   from "./_shared/platform";
import { listCookieStores, type CookieStore, type Browser } from "./_shared/browser";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "clear_browser_sso_cookies",
  description:
    "Deletes cookies for a single IDP domain from Chrome, Edge, Safari " +
    "(macOS), and Firefox profiles. The domain must be an exact host string " +
    "(no wildcards). Use ONLY after a cloud IDP password reset has been " +
    "confirmed. Dry-run returns the count of cookies that would be cleared " +
    "per profile without deleting anything.",
  riskLevel:       "medium",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
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
    dryRun: z
      .boolean()
      .optional()
      .describe("When true, return per-profile cookie counts without deleting."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface StoreResult {
  browser:   Browser;
  profile:   string;
  path:      string;
  /** cookies matched at dry-run time. */
  matched:   number;
  /** cookies actually deleted (0 on dry-run or failure). */
  deleted:   number;
  skipped?:  boolean;
  error?:    string;
}

export interface ClearCookiesResult {
  domain:          string;
  dryRun:          boolean;
  stores:          StoreResult[];
  totalMatched:    number;
  totalDeleted:    number;
  /** True when a required tool (sqlite3 on Windows) isn't on PATH. */
  missingSqlite?:  boolean;
}

// -- SQLite helpers via the sqlite3 CLI ---------------------------------------

/**
 * Probe for the sqlite3 CLI on every run.  We deliberately do NOT cache
 * this result — the tool runs at most once per plan step (~seconds of
 * work), so saving a single exec call is not worth the test-ordering
 * hazard a module-level cache introduces.
 */
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

async function sqliteExec(dbPath: string, query: string): Promise<void> {
  await execAsync(
    `sqlite3 ${JSON.stringify(dbPath)} ${JSON.stringify(query)}`,
    { maxBuffer: 1 * 1024 * 1024, timeout: 10_000 },
  );
}

async function clearSqliteStore(
  store:    CookieStore,
  domain:   string,
  dryRun:   boolean,
): Promise<StoreResult> {
  const column = store.browser === "firefox" ? "host" : "host_key";
  const predicate = buildHostPredicate(column, domain);
  const countSql  = `SELECT COUNT(*) FROM cookies WHERE ${predicate};`;
  const deleteSql = `DELETE FROM cookies WHERE ${predicate};`;

  try {
    if (!fs.existsSync(store.path)) {
      return {
        browser: store.browser, profile: store.profile, path: store.path,
        matched: 0, deleted: 0, skipped: true,
        error: "Cookies database no longer exists",
      };
    }

    const matched = await sqliteCount(store.path, countSql);
    if (dryRun || matched === 0) {
      return {
        browser: store.browser, profile: store.profile, path: store.path,
        matched, deleted: 0,
      };
    }
    await sqliteExec(store.path, deleteSql);
    return {
      browser: store.browser, profile: store.profile, path: store.path,
      matched, deleted: matched,
    };
  } catch (err) {
    const msg = (err as Error).message;
    return {
      browser: store.browser, profile: store.profile, path: store.path,
      matched: 0, deleted: 0, error: `sqlite error: ${msg}`,
    };
  }
}

// -- Safari via osascript -----------------------------------------------------

async function clearSafariCookies(domain: string, dryRun: boolean): Promise<StoreResult> {
  const safariStore: CookieStore = {
    browser: "safari",
    path:    "~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
    profile: "Default",
    format:  "binary",
  };

  if (!isDarwin()) {
    return {
      ...safariStore,
      matched: 0, deleted: 0, skipped: true,
      error: "Safari cookie clearing is macOS-only",
    };
  }
  if (dryRun) {
    // Safari's binary format is awkward to count without parsing it; return 0
    // and note the limitation so the consent card can surface it.
    return {
      ...safariStore,
      matched: 0, deleted: 0, skipped: true,
      error:
        "Safari cookie count is unavailable in dry-run — will be cleared via " +
        "Safari API when the user confirms.",
    };
  }

  // Use osascript + Safari to clear cookies for the domain.  Newer macOS
  // versions expose "remove cookies with name / domain" via AppleScript.
  // If Safari refuses, report the failure rather than throwing.
  const script =
    `tell application "Safari"\n` +
    `  try\n` +
    `    set cookiesList to (cookies whose domain is "${domain}")\n` +
    `    set theCount to count of cookiesList\n` +
    `    repeat with c in cookiesList\n` +
    `      delete c\n` +
    `    end repeat\n` +
    `    return theCount\n` +
    `  on error errMsg\n` +
    `    return "error: " & errMsg\n` +
    `  end try\n` +
    `end tell`;

  try {
    const { stdout } = await execAsync(
      `osascript -e ${JSON.stringify(script)}`,
      { maxBuffer: 1 * 1024 * 1024, timeout: 10_000 },
    );
    const out = stdout.trim();
    if (out.startsWith("error:")) {
      return {
        ...safariStore, matched: 0, deleted: 0,
        error: out,
      };
    }
    const n = parseInt(out, 10);
    if (isNaN(n)) {
      return {
        ...safariStore, matched: 0, deleted: 0,
        error: `osascript returned non-numeric output: ${out}`,
      };
    }
    return { ...safariStore, matched: n, deleted: n };
  } catch (err) {
    return {
      ...safariStore, matched: 0, deleted: 0,
      error: `osascript failed: ${(err as Error).message}`,
    };
  }
}

// Exported for unit tests.
export const __testing = { clearSqliteStore, clearSafariCookies, isSqlite3OnPath };

// -- Exported run function ----------------------------------------------------

export async function run({
  domain,
  dryRun = false,
}: {
  domain: string;
  dryRun?: boolean;
}): Promise<ClearCookiesResult> {
  const stores = listCookieStores();
  const sqliteOk = await isSqlite3OnPath();

  const out: StoreResult[] = [];
  let totalMatched = 0;
  let totalDeleted = 0;

  for (const s of stores) {
    if (s.format === "sqlite") {
      if (!sqliteOk) {
        out.push({
          browser: s.browser, profile: s.profile, path: s.path,
          matched: 0, deleted: 0, skipped: true,
          error:
            "sqlite3 command-line tool is not available on PATH — cannot " +
            "clear cookies for SQLite-backed browsers.",
        });
        continue;
      }
      const r = await clearSqliteStore(s, domain, dryRun);
      totalMatched += r.matched; totalDeleted += r.deleted;
      out.push(r);
    } else {
      const r = await clearSafariCookies(domain, dryRun);
      totalMatched += r.matched; totalDeleted += r.deleted;
      out.push(r);
    }
  }

  return {
    domain, dryRun, stores: out,
    totalMatched, totalDeleted,
    missingSqlite: sqliteOk ? undefined : true,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ domain: "okta.com", dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
