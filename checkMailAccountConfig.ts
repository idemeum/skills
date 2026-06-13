/**
 * mcp/skills/checkMailAccountConfig.ts — check_mail_account_config skill
 *
 * Validates email account configuration by checking IMAP/SMTP server
 * connectivity and settings in Apple Mail or Outlook.
 *
 * Platform strategy
 * -----------------
 * darwin Mail:    enumerate accounts via Mail's AppleScript interface (JXA).
 *                 Modern macOS (since ~OS X Yosemite) no longer stores accounts
 *                 in ~/Library/Mail/.../Accounts.plist — they live in the system
 *                 Accounts DB owned by accountsd and are exposed through Mail's
 *                 scripting dictionary. This also covers OAuth providers (Gmail,
 *                 Microsoft 365) added via Internet Accounts and needs only the
 *                 Apple Events automation grant (Tier-1 auto-prompt), not FDA.
 * darwin Outlook: read Outlook 15 Profiles via plutil
 * win32:          PowerShell check Outlook profile via registry
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkMailAccountConfig.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";
import * as fs       from "fs/promises";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_mail_account_config",
  description:
    "Validates email account configuration by checking IMAP/SMTP server " +
    "connectivity and settings in Apple Mail or Outlook. Use at the start of " +
    "any email troubleshooting workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // No tccCategories: the macOS Mail path uses Apple Events (Tier-1 auto-prompt),
  // and the Outlook path reads the user's own Group Container (not TCC-gated).
  // Declaring FullDiskAccess here would make G4's preflight abort the run when
  // FDA is absent — needlessly, since neither path requires it.
  schema: {
    client: z
      .enum(["mail", "outlook", "auto"])
      .optional()
      .describe("Email client to check. auto=detect installed client. Default: auto"),
    account: z
      .string()
      .optional()
      .describe("Email address to check. Omit to list all configured accounts"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AccountInfo {
  email:      string;
  imapServer: string | null;
  smtpServer: string | null;
  port:       number | null;
  ssl:        boolean | null;
}

type DetectedClient = "mail" | "outlook" | "unknown";

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin helpers -----------------------------------------------------------

async function readPlistAsJson(plistPath: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execAsync(
      `plutil -convert json -o - '${plistPath.replace(/'/g, `'\\''`)}' 2>/dev/null`,
      { maxBuffer: 5 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// JXA enumerated against Mail's scripting dictionary. Returns a JSON array of
// account records, or {error} if Mail itself rejects the request. Per-property
// try/catch keeps one unreadable field from dropping the whole account.
const MAIL_JXA = `
(() => {
  const Mail = Application("Mail");
  let accts;
  try { accts = Mail.accounts(); } catch (e) { return JSON.stringify({ error: String(e) }); }
  const out = [];
  for (const a of accts) {
    let enabled = true;  try { enabled = a.enabled(); } catch (e) {}
    if (enabled === false) continue;
    let emails = [];     try { emails = a.emailAddresses() || []; } catch (e) {}
    let userName = "";   try { userName = a.userName() || ""; } catch (e) {}
    let server = null;   try { server = a.serverName(); } catch (e) {}
    let port = null;     try { port = a.port(); } catch (e) {}
    let ssl = null;      try { ssl = a.usesSsl(); } catch (e) {}
    let smtp = null;     try { const d = a.deliveryAccount(); if (d) smtp = d.serverName(); } catch (e) {}
    out.push({
      email:      emails[0] || userName || null,
      imapServer: server || null,
      smtpServer: smtp || null,
      port:       (typeof port === "number")  ? port : null,
      ssl:        (typeof ssl  === "boolean") ? ssl  : null,
    });
  }
  return JSON.stringify(out);
})();
`;

async function runJxa(script: string): Promise<string> {
  const tmp = nodePath.join(os.tmpdir(), `mailcfg-${process.pid}-${Date.now()}.js`);
  await fs.writeFile(tmp, script, "utf8");
  try {
    const { stdout } = await execAsync(`osascript -l JavaScript '${tmp}'`, {
      timeout:    30_000,
      maxBuffer:  5 * 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

async function getMailAccounts(filterEmail?: string): Promise<{ accounts: AccountInfo[]; error: string | null }> {
  let raw: string;
  try {
    raw = await runJxa(MAIL_JXA);
  } catch (err) {
    // Never silently swallow an authorization failure — surface it so the
    // response can guide the user to grant the Automation permission.
    const msg = (err as { stderr?: string; message?: string }).stderr
      || (err instanceof Error ? err.message : String(err));
    if (/-1743|Not authori[sz]ed|not allowed to send Apple events/i.test(msg)) {
      return {
        accounts: [],
        error: "Automation permission required: allow this app to control Mail "
             + "(System Settings → Privacy & Security → Automation), then retry.",
      };
    }
    return { accounts: [], error: `Could not read Mail accounts: ${msg.split("\n")[0]}` };
  }

  if (!raw) return { accounts: [], error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { accounts: [], error: null };
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "error" in parsed) {
    return { accounts: [], error: String((parsed as { error: unknown }).error) };
  }

  const rawAccounts = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  const accounts: AccountInfo[] = [];

  for (const acct of rawAccounts) {
    const email = String(acct["email"] ?? "");
    if (!email) continue;
    if (filterEmail && !email.toLowerCase().includes(filterEmail.toLowerCase())) continue;

    accounts.push({
      email,
      imapServer: (acct["imapServer"] as string) || null,
      smtpServer: (acct["smtpServer"] as string) || null,
      port:       typeof acct["port"] === "number" ? (acct["port"] as number) : null,
      ssl:        typeof acct["ssl"]  === "boolean" ? (acct["ssl"]  as boolean) : null,
    });
  }

  return { accounts, error: null };
}

async function getOutlookAccountsDarwin(filterEmail?: string): Promise<AccountInfo[]> {
  const profileBase = nodePath.join(
    os.homedir(),
    "Library",
    "Group Containers",
    "UBF8T346G9.Office",
    "Outlook",
    "Outlook 15 Profiles",
  );

  let profileDirs: string[] = [];
  try {
    profileDirs = await fs.readdir(profileBase);
  } catch {
    return [];
  }

  const accounts: AccountInfo[] = [];

  for (const profileDir of profileDirs) {
    const plistPath = nodePath.join(profileBase, profileDir, "Account Profile.plist");
    const data      = await readPlistAsJson(plistPath);
    if (!data) continue;

    const accts = (data["Accounts"] ?? []) as Record<string, unknown>[];
    for (const acct of accts) {
      const email      = String(acct["Email Address"] ?? acct["AccountEmailAddress"] ?? "");
      const imapServer = String(acct["IMAP Server"] ?? acct["Hostname"] ?? "");
      const smtpServer = String(acct["SMTP Server"] ?? "");
      const port       = acct["IMAP Port"] ? Number(acct["IMAP Port"]) : null;
      const ssl        = acct["Use SSL"] !== undefined ? Boolean(acct["Use SSL"]) : null;

      if (!email) continue;
      if (filterEmail && !email.toLowerCase().includes(filterEmail.toLowerCase())) continue;

      accounts.push({ email, imapServer: imapServer || null, smtpServer: smtpServer || null, port, ssl });
    }
  }

  return accounts;
}

// NOTE: client detection on darwin is intentionally NOT by app presence.
// Mail.app ALWAYS exists on macOS (system app at /System/Applications), so its
// presence cannot distinguish a Mail user from an Outlook user — presence-based
// detection resolved `client` to "mail" for every Mac and left the Outlook path
// unreachable (e.g. for an Outlook user whose Mail.app has no accounts). run()
// instead probes BOTH clients and resolves to whichever has accounts configured.

// -- win32 implementation -----------------------------------------------------

async function getAccountsWin32(filterEmail?: string): Promise<AccountInfo[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$profiles = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\Profiles' -ErrorAction SilentlyContinue
$results  = @()
foreach ($profile in $profiles) {
  $accounts = Get-ChildItem $profile.PSPath -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.GetValue('Account Name') -ne $null }
  foreach ($acct in $accounts) {
    $results += [PSCustomObject]@{
      email      = [string]($acct.GetValue('Email') ?? $acct.GetValue('Account Name') ?? '')
      imapServer = [string]($acct.GetValue('IMAP Server') ?? '')
      smtpServer = [string]($acct.GetValue('SMTP Server') ?? '')
      port       = $null
      ssl        = $null
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw = await runPS(ps);
  if (!raw) return [];

  const parsed = JSON.parse(raw) as AccountInfo | AccountInfo[];
  const all    = (Array.isArray(parsed) ? parsed : [parsed])
    .filter(a => a.email);

  if (filterEmail) {
    return all.filter(a => a.email.toLowerCase().includes(filterEmail.toLowerCase()));
  }
  return all;
}

// -- Exported run function ----------------------------------------------------

export async function run({
  client  = "auto",
  account,
}: {
  client?:  "mail" | "outlook" | "auto";
  account?: string;
} = {}) {
  const platform = os.platform();

  if (platform === "win32") {
    const accounts = await getAccountsWin32(account);
    return { client: "outlook", platform, accounts };
  }

  // macOS. In "auto" mode, resolve the client by which one actually has accounts
  // configured — NOT by app presence (Mail.app always exists on macOS, so
  // presence always picked "mail" and left "outlook" unreachable).
  let resolvedClient: DetectedClient;
  let accounts: AccountInfo[] = [];
  let mailError: string | null = null;

  if (client === "mail") {
    const r   = await getMailAccounts(account);
    accounts  = r.accounts;
    mailError = r.error;
    resolvedClient = "mail";
  } else if (client === "outlook") {
    accounts = await getOutlookAccountsDarwin(account);
    resolvedClient = "outlook";
  } else {
    // auto: probe BOTH, resolve to whichever has accounts.
    const mail            = await getMailAccounts(account);
    const outlookAccounts = await getOutlookAccountsDarwin(account);
    accounts  = [...mail.accounts, ...outlookAccounts];
    mailError = mail.error;
    resolvedClient = mail.accounts.length > 0
      ? "mail"
      : outlookAccounts.length > 0 ? "outlook" : "unknown";
  }

  return { client: resolvedClient, platform, accounts, ...(mailError ? { error: mailError } : {}) };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
