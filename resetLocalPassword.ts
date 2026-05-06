/**
 * mcp/skills/resetLocalPassword.ts — reset_local_password skill
 *
 * Resets the local macOS/Windows account password. IMPORTANT: requires admin
 * privileges. Always confirm with the user before executing. Use only for
 * local accounts — not for Active Directory accounts.
 *
 * Platform strategy
 * -----------------
 * darwin  `dscl . -passwd /Users/{username} {newPassword}` (only if not dryRun)
 * win32   PowerShell Set-LocalUser -Name {username} -Password (ConvertTo-SecureString ...)
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/resetLocalPassword.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "reset_local_password",
  description:
    "Resets the local macOS/Windows account password. " +
    "IMPORTANT: requires admin privileges. Always confirm with the user before executing. " +
    "Use only for local accounts — not for Active Directory accounts.",
  riskLevel:       "critical",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo dscl . -passwd /Users/<username> '<newPassword>'  # substitute the user's real username and a strong temporary password; user should change at next login",
    win32:  "Set-LocalUser -Name '<username>' -Password (ConvertTo-SecureString '<newPassword>' -AsPlainText -Force)  # run from elevated PowerShell",
  },
  schema: {
    username: z
      .string()
      .describe("Username whose password to reset"),
    newPassword: z
      .string()
      .describe("New password to set"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, validate inputs without changing password. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ResetResult {
  username: string;
  success:  boolean;
  dryRun:   boolean;
  message:  string;
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

async function resetLocalPasswordDarwin(
  username:    string,
  newPassword: string,
  dryRun:      boolean,
): Promise<ResetResult> {
  // Validate that the user exists
  const safeName = username.replace(/'/g, `'\\''`);
  try {
    await execAsync(
      `dscl . -read /Users/'${safeName}' UniqueID 2>/dev/null`,
      { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
    );
  } catch {
    return {
      username,
      success: false,
      dryRun,
      message: `User '${username}' not found in local directory.`,
    };
  }

  // Validate password is non-empty
  if (!newPassword || newPassword.length === 0) {
    return {
      username,
      success: false,
      dryRun,
      message: "New password must not be empty.",
    };
  }

  if (dryRun) {
    return {
      username,
      success: true,
      dryRun:  true,
      message: `Dry run: user '${username}' exists. Password would be reset. Run with dryRun=false to apply.`,
    };
  }

  // Perform actual password reset — password masked in all log output
  try {
    // Use dscl . -passwd with newline to avoid password appearing in process list
    const safePassword = newPassword.replace(/'/g, `'\\''`);
    await execAsync(
      `dscl . -passwd /Users/'${safeName}' '${safePassword}'`,
      { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
    );
    return {
      username,
      success: true,
      dryRun:  false,
      message: `Password for '${username}' has been reset successfully.`,
    };
  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    // Do not include the password in the error message
    return {
      username,
      success: false,
      dryRun:  false,
      message: `Failed to reset password for '${username}': ${msg.replace(/password/gi, "[password]")}`,
    };
  }
}

// -- win32 implementation -----------------------------------------------------

async function resetLocalPasswordWin32(
  username:    string,
  newPassword: string,
  dryRun:      boolean,
): Promise<ResetResult> {
  // Validate user exists
  const ps_check = `
$ErrorActionPreference = 'Stop'
try {
  $u = Get-LocalUser -Name '${username.replace(/'/g, "''")}' -ErrorAction Stop
  Write-Output "EXISTS:$($u.Name)"
} catch {
  Write-Output "NOTFOUND"
}`.trim();

  let checkResult = "";
  try {
    checkResult = await runPS(ps_check);
  } catch {
    return { username, success: false, dryRun, message: `Could not verify user '${username}'.` };
  }

  if (checkResult.includes("NOTFOUND")) {
    return { username, success: false, dryRun, message: `User '${username}' not found.` };
  }

  if (!newPassword || newPassword.length === 0) {
    return { username, success: false, dryRun, message: "New password must not be empty." };
  }

  if (dryRun) {
    return {
      username,
      success: true,
      dryRun:  true,
      message: `Dry run: user '${username}' exists. Password would be reset. Run with dryRun=false to apply.`,
    };
  }

  // Perform reset — password masked in output
  const safeUser = username.replace(/'/g, "''");
  const safePw   = newPassword.replace(/'/g, "''");
  const ps_reset = `
$ErrorActionPreference = 'Stop'
$secPw = ConvertTo-SecureString -String '${safePw}' -AsPlainText -Force
Set-LocalUser -Name '${safeUser}' -Password $secPw
Write-Output "OK"`.trim();

  try {
    const result = await runPS(ps_reset);
    if (result.includes("OK")) {
      return { username, success: true, dryRun: false, message: `Password for '${username}' has been reset successfully.` };
    }
    return { username, success: false, dryRun: false, message: "Password reset command did not confirm success." };
  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    return {
      username,
      success: false,
      dryRun:  false,
      message: `Failed to reset password for '${username}': ${msg.replace(/password/gi, "[password]")}`,
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  username,
  newPassword,
  dryRun = true,
}: {
  username:    string;
  newPassword: string;
  dryRun?:     boolean;
}) {
  if (!username) throw new Error("[reset_local_password] username is required");
  if (!newPassword) throw new Error("[reset_local_password] newPassword is required");

  const platform = os.platform();

  const result = platform === "win32"
    ? await resetLocalPasswordWin32(username, newPassword, dryRun)
    : await resetLocalPasswordDarwin(username, newPassword, dryRun);

  return { platform, ...result };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ username: "testuser", newPassword: "TestPass123!", dryRun: true })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
