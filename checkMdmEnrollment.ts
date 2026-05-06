/**
 * mcp/skills/checkMdmEnrollment.ts — check_mdm_enrollment skill
 *
 * Checks whether this device is enrolled in an MDM (Mobile Device Management)
 * system such as Jamf, Intune, or Apple Business Manager. MDM enrollment
 * enables remote management and policy-pushed reinstalls.
 *
 * Platform strategy
 * -----------------
 * darwin  `profiles status -type enrollment`, `jamf checkJSSConnection`,
 *         `system_profiler SPConfigurationProfileDataType`
 * win32   PowerShell registry check under HKLM:\SOFTWARE\Microsoft\Enrollments
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkMdmEnrollment.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_mdm_enrollment",
  description:
    "Checks whether this device is enrolled in an MDM (Mobile Device Management) " +
    "system such as Jamf, Intune, or Apple Business Manager. MDM enrollment enables " +
    "remote management and policy-pushed reinstalls.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

type EnrollmentType = "user_approved" | "device_enrollment" | "none" | "unknown";

interface MdmEnrollmentResult {
  isEnrolled:          boolean;
  mdmProvider:         string | null;
  enrollmentType:      EnrollmentType;
  serverUrl:           string | null;
  supervised:          boolean | null;
  lastCheckinAttempt:  string | null;
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

async function checkMdmEnrollmentDarwin(): Promise<MdmEnrollmentResult> {
  let isEnrolled:         boolean         = false;
  let mdmProvider:        string | null   = null;
  let enrollmentType:     EnrollmentType  = "none";
  let serverUrl:          string | null   = null;
  let supervised:         boolean | null  = null;
  let lastCheckinAttempt: string | null   = null;

  // 1. profiles status -type enrollment
  try {
    const { stdout } = await execAsync(
      "profiles status -type enrollment 2>/dev/null",
      { maxBuffer: 1024 * 1024 },
    );
    const enrollmentLine = stdout.split("\n").find((l) => /MDM enrollment/i.test(l)) ?? "";
    if (/Yes/i.test(enrollmentLine)) {
      isEnrolled = true;
      enrollmentType = /User Approved/i.test(enrollmentLine)
        ? "user_approved"
        : "device_enrollment";
    }
  } catch {
    // profiles not available or permission denied
  }

  // 2. profiles show -type enrollment (more details, may need sudo)
  try {
    const { stdout } = await execAsync(
      "sudo profiles show -type enrollment 2>/dev/null",
      { maxBuffer: 2 * 1024 * 1024 },
    );
    // Parse server URL
    const urlMatch = stdout.match(/ServerURL\s*=\s*"?([^";\n]+)/i);
    if (urlMatch) serverUrl = urlMatch[1].trim();

    // Parse provider from org name or server URL
    if (!mdmProvider && serverUrl) {
      if (/jamf/i.test(serverUrl))   mdmProvider = "Jamf";
      if (/intune|microsoft/i.test(serverUrl)) mdmProvider = "Microsoft Intune";
      if (/apple/i.test(serverUrl))  mdmProvider = "Apple MDM";
      if (!mdmProvider)              mdmProvider = serverUrl;
    }

    const checkinMatch = stdout.match(/LastCheckin\s*=\s*([^\n;]+)/i);
    if (checkinMatch) lastCheckinAttempt = checkinMatch[1].trim();
  } catch {
    // Requires sudo — best effort
  }

  // 3. Check Jamf specifically
  if (!mdmProvider || mdmProvider === null) {
    try {
      const { stdout } = await execAsync(
        "jamf checkJSSConnection 2>/dev/null",
        { maxBuffer: 1024 * 1024 },
      );
      if (/successfully/i.test(stdout) || /connected/i.test(stdout)) {
        isEnrolled  = true;
        mdmProvider = "Jamf";
        // Extract server URL from jamf output if present
        const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
        if (urlMatch && !serverUrl) serverUrl = urlMatch[0];
      }
    } catch {
      // jamf not installed
    }
  }

  // 4. system_profiler for supervision status
  try {
    const { stdout } = await execAsync(
      "system_profiler SPConfigurationProfileDataType -json 2>/dev/null",
      { maxBuffer: 5 * 1024 * 1024 },
    );
    if (stdout.trim()) {
      const parsed = JSON.parse(stdout) as {
        SPConfigurationProfileDataType?: Array<{ _supervised?: boolean }>;
      };
      const profiles = parsed.SPConfigurationProfileDataType ?? [];
      if (profiles.length > 0) {
        isEnrolled  = true;
        supervised  = profiles[0]._supervised ?? null;
        if (!mdmProvider) mdmProvider = "Unknown MDM";
      }
    }
  } catch {
    // system_profiler may fail or return empty
  }

  return {
    isEnrolled,
    mdmProvider,
    enrollmentType: isEnrolled ? enrollmentType : "none",
    serverUrl,
    supervised,
    lastCheckinAttempt,
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkMdmEnrollmentWin32(): Promise<MdmEnrollmentResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$enrollments = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Enrollments' -ErrorAction SilentlyContinue |
               Get-ItemProperty -ErrorAction SilentlyContinue |
               Select-Object UPN,ProviderID,EnrollmentState,DiscoveryServiceFullURL
if ($enrollments) { @($enrollments) | ConvertTo-Json -Depth 2 -Compress } else { '[]' }`.trim();

  let isEnrolled:         boolean        = false;
  let mdmProvider:        string | null  = null;
  let serverUrl:          string | null  = null;
  let enrollmentType:     EnrollmentType = "none";
  let lastCheckinAttempt: string | null  = null;

  try {
    const raw    = await runPS(ps);
    const parsed = JSON.parse(raw ?? "[]") as Array<{
      UPN?:                    string;
      ProviderID?:             string;
      EnrollmentState?:        number;
      DiscoveryServiceFullURL?: string;
    }>;

    const active = parsed.filter((e) => e.EnrollmentState === 1);
    if (active.length > 0) {
      isEnrolled     = true;
      enrollmentType = "device_enrollment";
      mdmProvider    = active[0].ProviderID ?? null;
      serverUrl      = active[0].DiscoveryServiceFullURL ?? null;

      // Identify common providers
      if (mdmProvider) {
        if (/intune|microsoft/i.test(mdmProvider)) mdmProvider = "Microsoft Intune";
        if (/jamf/i.test(mdmProvider))             mdmProvider = "Jamf";
      } else if (serverUrl) {
        if (/intune|microsoft/i.test(serverUrl)) mdmProvider = "Microsoft Intune";
        if (/jamf/i.test(serverUrl))             mdmProvider = "Jamf";
      }
    }
  } catch {
    // Registry access failed
  }

  return {
    isEnrolled,
    mdmProvider,
    enrollmentType,
    serverUrl,
    supervised:         null,
    lastCheckinAttempt,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkMdmEnrollmentWin32()
    : checkMdmEnrollmentDarwin();
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
