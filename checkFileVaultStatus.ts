/**
 * mcp/skills/checkFileVaultStatus.ts — check_filevault_status skill
 *
 * Reports full-disk encryption status — FileVault on macOS, BitLocker on
 * Windows. Use during security compliance verification or when diagnosing
 * boot/authentication issues.
 *
 * Platform strategy
 * -----------------
 * darwin  `fdesetup status` and `fdesetup list`
 * win32   PowerShell Get-BitLockerVolume
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkFileVaultStatus.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_filevault_status",
  description:
    "Reports full-disk encryption status — FileVault on macOS, BitLocker on Windows. " +
    "Use during security compliance verification or when diagnosing boot/authentication issues.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface FileVaultResult {
  platform:          string;
  enabled:           boolean;
  status:            string;
  encryptionMethod:  string | null;
  encryptionPercent: number | null;
  enabledUsers:      string[];
  message:           string;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function checkFileVaultDarwin(): Promise<FileVaultResult> {
  // fdesetup status
  let statusOutput = "";
  try {
    ({ stdout: statusOutput } = await execAsync("fdesetup status 2>/dev/null", {
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    statusOutput = (err as { stdout?: string }).stdout ?? "";
  }

  const enabled = /FileVault is On/i.test(statusOutput);
  const status  = statusOutput.trim() || "Unknown";

  // fdesetup list — may require sudo; best-effort
  let enabledUsers: string[] = [];
  try {
    const { stdout: listOutput } = await execAsync("fdesetup list 2>/dev/null", {
      maxBuffer: 1024 * 1024,
    });
    enabledUsers = listOutput
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(",")[0].trim())
      .filter(Boolean);
  } catch {
    // May require sudo — silently ignore
  }

  return {
    platform:          "darwin",
    enabled,
    status,
    encryptionMethod:  enabled ? "XTS-AES-128" : null,
    encryptionPercent: enabled ? 100 : 0,
    enabledUsers,
    message: enabled
      ? `FileVault is enabled. ${enabledUsers.length} user(s) can unlock the disk.`
      : "FileVault is disabled. Disk is not encrypted.",
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkFileVaultWin32(): Promise<FileVaultResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$vols = Get-BitLockerVolume | Select-Object MountPoint,EncryptionMethod,VolumeStatus,ProtectionStatus,EncryptionPercentage
if ($vols) { @($vols) | ConvertTo-Json -Depth 2 -Compress } else { '[]' }`.trim();

  let enabled           = false;
  let status            = "Unknown";
  let encryptionMethod: string | null  = null;
  let encryptionPercent: number | null = null;
  let message           = "";

  try {
    const raw    = await runPS(ps);
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      MountPoint:           string;
      EncryptionMethod:     string;
      VolumeStatus:         string;
      ProtectionStatus:     string;
      EncryptionPercentage: number;
    }>;

    if (parsed.length > 0) {
      const systemVol   = parsed.find((v) => v.MountPoint === "C:") ?? parsed[0];
      enabled           = systemVol.ProtectionStatus === "On";
      status            = systemVol.VolumeStatus;
      encryptionMethod  = systemVol.EncryptionMethod || null;
      encryptionPercent = systemVol.EncryptionPercentage ?? null;
      message           = `BitLocker on C: is ${enabled ? "ON" : "OFF"}. ` +
                          `Volume status: ${status}. ` +
                          `${encryptionPercent}% encrypted.`;
    } else {
      message = "No BitLocker volumes found or BitLocker is not available.";
    }
  } catch (err) {
    message = `Error reading BitLocker status: ${(err as Error).message}`;
  }

  return {
    platform: "win32",
    enabled,
    status,
    encryptionMethod,
    encryptionPercent,
    enabledUsers: [],
    message,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkFileVaultWin32()
    : checkFileVaultDarwin();
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
