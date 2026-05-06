/**
 * mcp/skills/getAccountInfo.ts — get_account_info skill
 *
 * Returns current user account details including username, full name, home
 * directory, shell, account type (admin/standard), and password policy
 * settings. Use at the start of any password reset or account repair workflow.
 *
 * Platform strategy
 * -----------------
 * darwin  `id`, `dscl . -read /Users/$(whoami)`, `pwpolicy -getaccountpolicies`
 * win32   PowerShell [System.Security.Principal.WindowsIdentity]::GetCurrent()
 *         and Get-LocalUser
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getAccountInfo.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_account_info",
  description:
    "Returns current user account details including username, full name, home " +
    "directory, shell, account type (admin/standard), and password policy settings. " +
    "Use at the start of any password reset or account repair workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface AccountInfo {
  username:          string;
  fullName:          string | null;
  homeDir:           string;
  shell:             string | null;
  isAdmin:           boolean;
  accountType:       "admin" | "standard" | "unknown";
  passwordLastSet:   string | null;
  passwordExpiresIn: number | null;
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

async function getAccountInfoDarwin(): Promise<AccountInfo> {
  const username = os.userInfo().username;
  const homeDir  = os.homedir();

  // Get admin group membership
  let isAdmin = false;
  try {
    const { stdout: idOut } = await execAsync("id", { maxBuffer: 1 * 1024 * 1024 });
    isAdmin = idOut.includes("admin") || idOut.includes("(wheel)");
  } catch {
    // ignore
  }

  // Get full name and shell from dscl
  let fullName: string | null = null;
  let shell:    string | null = null;
  try {
    const safeName = username.replace(/'/g, `'\\''`);
    const { stdout: dsclOut } = await execAsync(
      `dscl . -read /Users/'${safeName}' RealName UserShell 2>/dev/null`,
      { maxBuffer: 2 * 1024 * 1024, shell: "/bin/bash" },
    );
    const realNameMatch = dsclOut.match(/RealName:\s*\n?\s*(.+)/);
    if (realNameMatch) fullName = realNameMatch[1].trim();
    const shellMatch = dsclOut.match(/UserShell:\s*(.+)/);
    if (shellMatch) shell = shellMatch[1].trim();
  } catch {
    // ignore dscl errors
  }

  // Get password policy info
  let passwordLastSet:   string | null = null;
  let passwordExpiresIn: number | null = null;
  try {
    const safeName = username.replace(/'/g, `'\\''`);
    const { stdout: pwOut } = await execAsync(
      `pwpolicy -u '${safeName}' -getpolicy 2>/dev/null`,
      { maxBuffer: 2 * 1024 * 1024, shell: "/bin/bash" },
    );
    const maxAgeMatch = pwOut.match(/maxMinutesUntilChangePassword=(\d+)/);
    if (maxAgeMatch) {
      const maxMinutes = parseInt(maxAgeMatch[1], 10);
      if (maxMinutes > 0) {
        passwordExpiresIn = Math.floor(maxMinutes / 1440); // convert to days
      }
    }
  } catch {
    // pwpolicy may not be available or may require elevated privileges
  }

  // Try to get password last set time from dscl
  try {
    const safeName = username.replace(/'/g, `'\\''`);
    const { stdout: dsclPwOut } = await execAsync(
      `dscl . -read /Users/'${safeName}' passwordLastSetTime 2>/dev/null`,
      { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
    );
    const tsMatch = dsclPwOut.match(/passwordLastSetTime:\s*(.+)/);
    if (tsMatch) {
      const tsVal = parseFloat(tsMatch[1].trim());
      if (!isNaN(tsVal) && tsVal > 0) {
        // macOS stores as CFAbsoluteTime (seconds since 2001-01-01)
        const epochOffset = 978307200; // seconds between 1970 and 2001
        passwordLastSet = new Date((tsVal + epochOffset) * 1000).toISOString();
      }
    }
  } catch {
    // ignore
  }

  return {
    username,
    fullName:         fullName ?? username,
    homeDir,
    shell:            shell ?? process.env["SHELL"] ?? null,
    isAdmin,
    accountType:      isAdmin ? "admin" : "standard",
    passwordLastSet,
    passwordExpiresIn,
  };
}

// -- win32 implementation -----------------------------------------------------

async function getAccountInfoWin32(): Promise<AccountInfo> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($id)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
$username = $env:USERNAME
$user = Get-LocalUser -Name $username
$obj = [PSCustomObject]@{
  username          = $username
  fullName          = $user.FullName
  homeDir           = $env:USERPROFILE
  shell             = $env:ComSpec
  isAdmin           = $isAdmin
  accountType       = if ($isAdmin) { 'admin' } else { 'standard' }
  passwordLastSet   = if ($user.PasswordLastSet) { $user.PasswordLastSet.ToString('o') } else { $null }
  passwordExpiresIn = if ($user.PasswordExpires) {
    [int]($user.PasswordExpires - (Get-Date)).TotalDays
  } else { $null }
}
$obj | ConvertTo-Json -Compress`.trim();

  const raw = await runPS(ps);
  const parsed = JSON.parse(raw) as AccountInfo;
  return parsed;
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();

  const info = platform === "win32"
    ? await getAccountInfoWin32()
    : await getAccountInfoDarwin();

  return { platform, ...info };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
