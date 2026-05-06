/**
 * mcp/skills/checkPasswordExpiry.ts — check_password_expiry skill
 *
 * Checks whether the current user's password is expired or expiring soon.
 * Works for both local accounts and Active Directory bound accounts. Use at
 * the start of a password reset workflow.
 *
 * Platform strategy
 * -----------------
 * darwin  `pwpolicy -u {username} -getpolicy` and
 *         `dscl . -read /Users/{username} passwordLastSetTime`
 * win32   PowerShell `net user {username}` and parse "Password expires"
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkPasswordExpiry.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_password_expiry",
  description:
    "Checks whether the current user's password is expired or expiring soon. " +
    "Works for both local accounts and Active Directory bound accounts. " +
    "Use at the start of a password reset workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    username: z
      .string()
      .optional()
      .describe("Username to check. Defaults to current user"),
  },
  // Top-level keys proactive-trigger DSL conditions may reference.
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  outputKeys: [
    "platform",
    "username",
    "isExpired",
    "expiresInDays",
    "lastChanged",
    "neverExpires",
  ],
} as const;

// -- Types --------------------------------------------------------------------

interface PasswordExpiryInfo {
  username:      string;
  isExpired:     boolean;
  expiresInDays: number | null;
  lastChanged:   string | null;
  neverExpires:  boolean;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function checkPasswordExpiryDarwin(username: string): Promise<PasswordExpiryInfo> {
  const safeName = username.replace(/'/g, `'\\''`);

  // Get password last set time
  let lastChanged:    string | null = null;
  let lastChangedDate: Date | null  = null;
  try {
    const { stdout } = await execAsync(
      `dscl . -read /Users/'${safeName}' passwordLastSetTime 2>/dev/null`,
      { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
    );
    const match = stdout.match(/passwordLastSetTime:\s*(.+)/);
    if (match) {
      const tsVal = parseFloat(match[1].trim());
      if (!isNaN(tsVal) && tsVal > 0) {
        const epochOffset = 978307200; // CFAbsoluteTime offset (2001-01-01)
        lastChangedDate = new Date((tsVal + epochOffset) * 1000);
        lastChanged     = lastChangedDate.toISOString();
      }
    }
  } catch {
    // ignore
  }

  // Get max password age policy
  let maxAgeDays:   number | null = null;
  let neverExpires: boolean       = false;
  try {
    const { stdout } = await execAsync(
      `pwpolicy -u '${safeName}' -getpolicy 2>/dev/null`,
      { maxBuffer: 2 * 1024 * 1024, shell: "/bin/bash" },
    );
    const maxMinMatch = stdout.match(/maxMinutesUntilChangePassword=(\d+)/);
    if (maxMinMatch) {
      const maxMinutes = parseInt(maxMinMatch[1], 10);
      if (maxMinutes === 0) {
        neverExpires = true;
      } else {
        maxAgeDays = Math.floor(maxMinutes / 1440);
      }
    } else {
      // No policy found — assume never expires
      neverExpires = true;
    }
  } catch {
    neverExpires = true;
  }

  let isExpired:     boolean      = false;
  let expiresInDays: number | null = null;

  if (!neverExpires && maxAgeDays !== null && lastChangedDate !== null) {
    const expiryDate   = new Date(lastChangedDate.getTime() + maxAgeDays * 86400 * 1000);
    const now          = new Date();
    const diffMs       = expiryDate.getTime() - now.getTime();
    expiresInDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    isExpired     = expiresInDays < 0;
  }

  return { username, isExpired, expiresInDays, lastChanged, neverExpires };
}

// -- win32 implementation -----------------------------------------------------

async function checkPasswordExpiryWin32(username: string): Promise<PasswordExpiryInfo> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$username = '${username.replace(/'/g, "''")}'
$netOut = (net user $username 2>&1) -join "\`n"
$lastSet   = $null
$expiresOn = $null
foreach ($line in ($netOut -split "\`n")) {
  if ($line -match 'Password last set.*?(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2})') {
    $lastSet = $matches[1]
  }
  if ($line -match 'Password expires.*?(\d{1,2}/\d{1,2}/\d{4}|\d{4}-\d{2}-\d{2}|Never)') {
    $expiresOn = $matches[1]
  }
}
$neverExpires  = ($expiresOn -eq 'Never') -or ($null -eq $expiresOn)
$isExpired     = $false
$expiresInDays = $null
if (-not $neverExpires -and $expiresOn) {
  $expDate = [datetime]::Parse($expiresOn)
  $diff    = ($expDate - (Get-Date)).TotalDays
  $expiresInDays = [int][Math]::Ceiling($diff)
  $isExpired     = $diff -lt 0
}
[PSCustomObject]@{
  username      = $username
  isExpired     = $isExpired
  expiresInDays = $expiresInDays
  lastChanged   = $lastSet
  neverExpires  = $neverExpires
} | ConvertTo-Json -Compress`.trim();

  const raw    = await runPS(ps);
  const parsed = JSON.parse(raw) as PasswordExpiryInfo;
  return parsed;
}

// -- Exported run function ----------------------------------------------------

export async function run({
  username,
}: {
  username?: string;
} = {}) {
  const platform      = os.platform();
  const resolvedUser  = username ?? os.userInfo().username;

  const info = platform === "win32"
    ? await checkPasswordExpiryWin32(resolvedUser)
    : await checkPasswordExpiryDarwin(resolvedUser);

  return { platform, ...info };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
