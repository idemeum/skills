/**
 * mcp/skills/checkMailPermissions.ts — check_mail_permissions skill
 *
 * Checks file system permissions on the Mail data directory.
 * Incorrect permissions cause Mail sync failures and index corruption.
 * macOS only.
 *
 * Platform strategy
 * -----------------
 * darwin  Checks ~/Library/Mail for existence and R/W access.
 *         Parses ownership from `ls -la ~/Library/` and optionally repairs
 *         with `chown -R $(whoami) ~/Library/Mail`.
 * win32   Not supported — use check_mail_account_config for Windows diagnostics.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkMailPermissions.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import * as fs       from "fs";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_mail_permissions",
  description:
    "Checks file system permissions on the Mail data directory. " +
    "Incorrect permissions cause Mail sync failures and index corruption. " +
    "macOS only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    fix: z
      .boolean()
      .optional()
      .describe(
        "If true, attempt to repair permissions with chown/chmod. Default: false",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface CheckMailPermissionsResult {
  mailDir:        string;
  exists:         boolean;
  readable:       boolean;
  writable:       boolean;
  owner:          string | null;
  currentUser:    string;
  permissionsOk:  boolean;
  fixed:          boolean;
  supported?:     boolean;
  message:        string;
}

// -- darwin implementation ----------------------------------------------------

async function checkMailPermissionsDarwin(fix: boolean): Promise<CheckMailPermissionsResult> {
  const home    = os.homedir();
  const mailDir = nodePath.join(home, "Library", "Mail");

  // Get current user
  let currentUser = "unknown";
  try {
    const { stdout } = await execAsync("whoami");
    currentUser = stdout.trim();
  } catch {
    // Fallback to os.userInfo
    try { currentUser = os.userInfo().username; } catch { /* ignore */ }
  }

  // Check if Mail directory exists
  let exists = false;
  try {
    await fs.promises.access(mailDir);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      mailDir,
      exists:        false,
      readable:      false,
      writable:      false,
      owner:         null,
      currentUser,
      permissionsOk: false,
      fixed:         false,
      message:       `Mail directory not found at ${mailDir}. Apple Mail may not be configured.`,
    };
  }

  // Check read/write access
  let readable = false;
  let writable = false;
  try {
    await fs.promises.access(mailDir, fs.constants.R_OK);
    readable = true;
  } catch { /* no read access */ }
  try {
    await fs.promises.access(mailDir, fs.constants.W_OK);
    writable = true;
  } catch { /* no write access */ }

  // Parse ownership from `ls -la ~/Library/`
  let owner: string | null = null;
  try {
    const { stdout } = await execAsync(`ls -la '${home.replace(/'/g, "'\\''")}/Library/'`);
    const lines = stdout.split("\n");
    for (const line of lines) {
      // Match "Mail" entry — look for the entry ending in " Mail" or " Mail/"
      if (/\bMail\/?$/.test(line.trim())) {
        const parts = line.trim().split(/\s+/);
        // ls -la: permissions links owner group size date... name
        if (parts.length >= 4) {
          owner = parts[2]; // owner field
        }
        break;
      }
    }
  } catch {
    // Non-fatal — owner stays null
  }

  const permissionsOk = readable && writable && (owner === null || owner === currentUser);

  let fixed = false;
  if (fix && (!readable || !writable || (owner !== null && owner !== currentUser))) {
    try {
      await execAsync(`chown -R $(whoami) '${mailDir.replace(/'/g, "'\\''")}'`);
      fixed = true;
    } catch {
      // Fix failed — non-fatal
    }
  }

  const message = fixed
    ? "Permissions repaired with chown -R. Restart Mail to apply changes."
    : permissionsOk
      ? "Mail directory permissions look correct."
      : `Permission issues detected — readable:${readable}, writable:${writable}, owner:${owner ?? "unknown"} vs currentUser:${currentUser}. Run with fix=true to attempt repair.`;

  return { mailDir, exists, readable, writable, owner, currentUser, permissionsOk, fixed, message };
}

// -- win32 implementation -----------------------------------------------------

async function checkMailPermissionsWin32(_fix: boolean): Promise<CheckMailPermissionsResult> {
  return {
    mailDir:       "",
    exists:        false,
    readable:      false,
    writable:      false,
    owner:         null,
    currentUser:   "",
    permissionsOk: false,
    fixed:         false,
    supported:     false,
    message:       "Use check_mail_account_config for Windows Outlook diagnostics.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  fix = false,
}: {
  fix?: boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkMailPermissionsWin32(fix)
    : checkMailPermissionsDarwin(fix);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
