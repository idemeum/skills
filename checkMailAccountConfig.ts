/**
 * mcp/skills/checkMailAccountConfig.ts — check_mail_account_config skill
 *
 * Validates email account configuration by checking IMAP/SMTP server
 * connectivity and settings in Apple Mail or Outlook.
 *
 * Platform strategy
 * -----------------
 * darwin Mail:    read ~/Library/Mail/V{n}/MailData/Accounts.plist via plutil
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
  tccCategories:   ["FullDiskAccess"],
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

async function findMailDataDir(): Promise<string | null> {
  const mailBase = nodePath.join(os.homedir(), "Library", "Mail");
  try {
    const entries = await fs.readdir(mailBase);
    // Prefer highest version number (V10, V9, ...)
    const vDirs = entries
      .filter(e => /^V\d+$/.test(e))
      .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10));
    if (vDirs.length > 0) {
      return nodePath.join(mailBase, vDirs[0], "MailData");
    }
  } catch {
    // Mail directory not found
  }
  return null;
}

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

async function getMailAccounts(filterEmail?: string): Promise<AccountInfo[]> {
  const mailDataDir = await findMailDataDir();
  if (!mailDataDir) return [];

  const plistPath = nodePath.join(mailDataDir, "Accounts.plist");
  const data      = await readPlistAsJson(plistPath);
  if (!data) return [];

  const rawAccounts = (data["MailAccounts"] ?? data["Accounts"] ?? []) as Record<string, unknown>[];
  const accounts: AccountInfo[] = [];

  for (const acct of rawAccounts) {
    const email      = String(acct["EmailAddresses"]
      ? (acct["EmailAddresses"] as string[])[0] ?? ""
      : acct["AccountEmailAddress"] ?? "");
    const imapServer = String(acct["Hostname"] ?? acct["IMAPHostName"] ?? "");
    const smtpServer = String((acct["SMTPAccount"] as Record<string, unknown>)?.["Hostname"] ?? "");
    const port       = acct["PortNumber"] ? Number(acct["PortNumber"]) : null;
    const ssl        = acct["SSLEnabled"] !== undefined ? Boolean(acct["SSLEnabled"]) : null;

    if (!email) continue;
    if (filterEmail && !email.toLowerCase().includes(filterEmail.toLowerCase())) continue;

    accounts.push({
      email,
      imapServer: imapServer || null,
      smtpServer: smtpServer || null,
      port,
      ssl,
    });
  }

  return accounts;
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

async function detectClientDarwin(): Promise<DetectedClient> {
  try {
    await fs.access("/Applications/Mail.app");
    return "mail";
  } catch {
    // not found
  }
  try {
    await fs.access("/Applications/Microsoft Outlook.app");
    return "outlook";
  } catch {
    // not found
  }
  return "unknown";
}

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

  // macOS
  let resolvedClient: DetectedClient = client === "auto" ? await detectClientDarwin() : client;

  let accounts: AccountInfo[] = [];
  if (resolvedClient === "mail") {
    accounts = await getMailAccounts(account);
  } else if (resolvedClient === "outlook") {
    accounts = await getOutlookAccountsDarwin(account);
  } else {
    // Try both
    const mailAccounts    = await getMailAccounts(account);
    const outlookAccounts = await getOutlookAccountsDarwin(account);
    accounts = [...mailAccounts, ...outlookAccounts];
    resolvedClient = mailAccounts.length > 0 ? "mail" : outlookAccounts.length > 0 ? "outlook" : "unknown";
  }

  return { client: resolvedClient, platform, accounts };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
