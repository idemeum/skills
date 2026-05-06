/**
 * mcp/skills/checkSipStatus.ts — check_sip_status skill
 *
 * Checks System Integrity Protection (SIP) status on macOS, or Secure Boot +
 * Windows Defender status on Windows. SIP must be enabled for most security
 * agents and MDM tools to function correctly.
 *
 * Platform strategy
 * -----------------
 * darwin  `csrutil status`
 * win32   PowerShell Confirm-SecureBootUEFI and Get-MpComputerStatus
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkSipStatus.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_sip_status",
  description:
    "Checks System Integrity Protection (SIP) status on macOS, or Secure Boot + " +
    "Windows Defender status on Windows. SIP must be enabled for most security " +
    "agents and MDM tools to function correctly.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface SipStatusResult {
  platform:          string;
  sipEnabled:        boolean | null;
  secureBootEnabled: boolean | null;
  status:            string;
  isCompliant:       boolean;
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

async function checkSipDarwin(): Promise<SipStatusResult> {
  let statusOutput = "";
  try {
    ({ stdout: statusOutput } = await execAsync("csrutil status 2>/dev/null", {
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    statusOutput = (err as { stdout?: string }).stdout ?? "";
  }

  const raw        = statusOutput.trim();
  const sipEnabled = /enabled/i.test(raw) && !/disabled/i.test(raw);
  const status     = raw || "Unknown";

  return {
    platform:          "darwin",
    sipEnabled,
    secureBootEnabled: null,
    status,
    isCompliant:       sipEnabled,
    message: sipEnabled
      ? "SIP is enabled. System Integrity Protection is active and enforced."
      : "SIP is DISABLED. This reduces system security and may prevent security agents from loading properly.",
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkSipWin32(): Promise<SipStatusResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$secureBoot = $null
try {
  $secureBoot = Confirm-SecureBootUEFI -ErrorAction SilentlyContinue
} catch {}
$mp = Get-MpComputerStatus -ErrorAction SilentlyContinue |
      Select-Object AntispywareEnabled,RealTimeProtectionEnabled
[PSCustomObject]@{
  secureBootEnabled          = $secureBoot
  antispywareEnabled         = if ($mp) { $mp.AntispywareEnabled } else { $null }
  realTimeProtectionEnabled  = if ($mp) { $mp.RealTimeProtectionEnabled } else { $null }
} | ConvertTo-Json -Compress`.trim();

  let secureBootEnabled: boolean | null = null;
  let antispywareEnabled                = false;
  let rtpEnabled                        = false;
  let status                            = "Unknown";

  try {
    const raw    = await runPS(ps);
    const parsed = JSON.parse(raw) as {
      secureBootEnabled?:         boolean | null;
      antispywareEnabled?:        boolean | null;
      realTimeProtectionEnabled?: boolean | null;
    };
    secureBootEnabled  = parsed.secureBootEnabled ?? null;
    antispywareEnabled = parsed.antispywareEnabled ?? false;
    rtpEnabled         = parsed.realTimeProtectionEnabled ?? false;

    const parts: string[] = [];
    if (secureBootEnabled !== null) parts.push(`Secure Boot: ${secureBootEnabled ? "ON" : "OFF"}`);
    parts.push(`Antispyware: ${antispywareEnabled ? "ON" : "OFF"}`);
    parts.push(`Real-time protection: ${rtpEnabled ? "ON" : "OFF"}`);
    status = parts.join(" | ");
  } catch (err) {
    status = `Error reading security status: ${(err as Error).message}`;
  }

  const isCompliant = (secureBootEnabled !== false) && antispywareEnabled && rtpEnabled;

  return {
    platform:          "win32",
    sipEnabled:        null,
    secureBootEnabled,
    status,
    isCompliant,
    message: isCompliant
      ? "Windows security features are enabled and compliant."
      : "One or more Windows security features are disabled. Review status for details.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkSipWin32()
    : checkSipDarwin();
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
