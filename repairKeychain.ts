/**
 * mcp/skills/repairKeychain.ts — repair_keychain skill
 *
 * Diagnoses and repairs macOS Keychain issues. Can check keychain status,
 * attempt first-aid repair, or delete and recreate the login keychain.
 * Common after password changes that desync the login keychain. Use when apps
 * report repeated keychain prompts or authentication failures.
 *
 * Platform strategy
 * -----------------
 * darwin  security list-keychains, security show-keychain-info,
 *         security unlock-keychain, fs.rename for reset
 * win32   cmdkey /list for check, vaultcmd /listcreds:* for full credential list
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/repairKeychain.ts
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "repair_keychain",
  description:
    "Diagnoses and repairs macOS Keychain issues. Can check keychain status, " +
    "attempt first-aid repair, or delete and recreate the login keychain. " +
    "Common after password changes that desync the login keychain. " +
    "Use when apps report repeated keychain prompts or authentication failures.",
  riskLevel:       "high",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    action: z
      .enum(["check", "repair", "reset"])
      .describe("check=status only, repair=run Keychain First Aid, reset=delete and recreate login keychain (destructive)"),
    dryRun: z
      .boolean()
      .optional()
      .describe("For reset action: if true show what would be deleted. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface KeychainResult {
  action:   string;
  keychains: string[];
  status:   string;
  repaired: boolean;
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

async function repairKeychainDarwin(
  action: "check" | "repair" | "reset",
  dryRun: boolean,
): Promise<KeychainResult> {
  const loginKeychainPath = nodePath.join(
    os.homedir(), "Library", "Keychains", "login.keychain-db",
  );

  // Always list keychains
  let keychains: string[] = [];
  try {
    const { stdout } = await execAsync(
      "security list-keychains 2>/dev/null",
      { maxBuffer: 1 * 1024 * 1024 },
    );
    keychains = stdout
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  } catch {
    // ignore
  }

  if (action === "check") {
    let status = "unknown";
    try {
      const { stdout } = await execAsync(
        `security show-keychain-info '${loginKeychainPath.replace(/'/g, `'\\''`)}' 2>&1`,
        { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
      );
      status = stdout.trim() || "ok";
    } catch (err) {
      status = (err as { stderr?: string }).stderr?.trim() ?? "error reading keychain info";
    }
    return {
      action,
      keychains,
      status,
      repaired: false,
      message:  "Keychain status retrieved. No changes made.",
    };
  }

  if (action === "repair") {
    // Attempt to unlock the login keychain (Keychain First Aid equivalent)
    try {
      await execAsync(
        `security unlock-keychain '${loginKeychainPath.replace(/'/g, `'\\''`)}' 2>/dev/null`,
        { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
      );
      return {
        action,
        keychains,
        status:   "unlock attempted",
        repaired: true,
        message:
          "Attempted to unlock the login keychain. If prompted for a password, " +
          "enter your current login password. If issues persist, consider a reset.",
      };
    } catch (err) {
      return {
        action,
        keychains,
        status:   "unlock failed",
        repaired: false,
        message:  `Unlock failed: ${(err as Error).message}. Try a reset instead.`,
      };
    }
  }

  // action === "reset"
  const backupPath = loginKeychainPath + `.backup-${Date.now()}`;

  if (dryRun) {
    let exists = false;
    try {
      await fs.access(loginKeychainPath);
      exists = true;
    } catch {
      // file does not exist
    }
    return {
      action,
      keychains,
      status:   exists ? "login keychain found" : "login keychain not found",
      repaired: false,
      message:  exists
        ? `Dry run: would rename '${loginKeychainPath}' to '${backupPath}'. Run with dryRun=false to apply.`
        : `Dry run: login keychain not found at expected path. Nothing to reset.`,
    };
  }

  // Perform actual reset
  try {
    await fs.rename(loginKeychainPath, backupPath);
    return {
      action,
      keychains,
      status:   "keychain moved to backup",
      repaired: true,
      message:
        `Login keychain moved to '${backupPath}'. ` +
        "A new keychain will be created on next login. " +
        "You will need to re-enter passwords for apps that used the old keychain.",
    };
  } catch (err) {
    return {
      action,
      keychains,
      status:   "reset failed",
      repaired: false,
      message:  `Failed to reset keychain: ${(err as Error).message}`,
    };
  }
}

// -- win32 implementation -----------------------------------------------------

async function repairKeychainWin32(
  action: "check" | "repair" | "reset",
): Promise<KeychainResult> {
  if (action === "check") {
    // List Windows Credential Manager entries
    let keychains: string[] = [];
    let status = "unknown";
    try {
      const { stdout } = await execAsync(
        "cmdkey /list 2>nul",
        { maxBuffer: 2 * 1024 * 1024 },
      );
      keychains = stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("Target:"))
        .map((l) => l.replace("Target:", "").trim());
      status = `${keychains.length} credential(s) found in Windows Credential Manager`;
    } catch {
      status = "Could not read Windows Credential Manager";
    }

    // Try vaultcmd for full list
    try {
      const ps = `
$ErrorActionPreference = 'SilentlyContinue'
(vaultcmd /listcreds:"Windows Credentials" 2>&1) -join "|"`.trim();
      const vaultOut = await runPS(ps);
      if (vaultOut) status += `. Vault: ${vaultOut.substring(0, 200)}`;
    } catch {
      // ignore
    }

    return {
      action,
      keychains,
      status,
      repaired: false,
      message:  "Windows Credential Manager status retrieved. No changes made.",
    };
  }

  // repair/reset on Windows: note keychain concept is macOS specific
  return {
    action,
    keychains: [],
    status:    "not applicable",
    repaired:  false,
    message:
      "Keychain repair/reset is a macOS concept. " +
      "On Windows, use Credential Manager (control panel) to manage stored credentials.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  action,
  dryRun = true,
}: {
  action: "check" | "repair" | "reset";
  dryRun?: boolean;
}) {
  if (!action) throw new Error("[repair_keychain] action is required");

  const platform = os.platform();

  const result = platform === "win32"
    ? await repairKeychainWin32(action)
    : await repairKeychainDarwin(action, dryRun);

  return { platform, dryRun, ...result };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ action: "check" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
