/**
 * mcp/skills/checkMdmEnrollment.ts — check_mdm_enrollment skill
 *
 * Checks whether this device is enrolled in an MDM (Mobile Device Management)
 * system such as Jamf, Intune, or Apple Business Manager. MDM enrollment
 * enables remote management and policy-pushed reinstalls.
 *
 * Platform strategy
 * -----------------
 * darwin  `profiles status -type enrollment`, `sudo -n profiles show -type enrollment`,
 *         `jamf checkJSSConnection`, `system_profiler SPConfigurationProfileDataType`
 * win32   PowerShell registry check under HKLM:\SOFTWARE\Microsoft\Enrollments
 *
 * Hang prevention
 * ---------------
 * Every `exec` call carries a 5 s internal timeout, and the whole platform call
 * races a 8 s top-level budget so a wedged subprocess can never block past the
 * G3 probe (3 s) or trip the G4 global tool timeout (30 s). `sudo` is invoked
 * with `-n` (non-interactive) so it fails fast when cached credentials are
 * absent, instead of hanging on a TTY-less password prompt.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkMdmEnrollment.ts
 */

import * as os         from "os";
import { execAsync }   from "./_shared/platform";

// -- Internal timing constants ------------------------------------------------
//
// Per-exec timeout (5 s) is well below G3's per-tool budget (3 s × parallel)
// and the G4 global tool timeout (30 s).  The top-level race budget (8 s) is
// the worst-case for a tool that must run several `exec` calls in series on a
// healthy MDM-enrolled Mac.

const EXEC_TIMEOUT_MS    = 5_000;
const OVERALL_BUDGET_MS  = 8_000;
const EXEC_KILL_SIGNAL   = "SIGKILL" as const;

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

/**
 * `source` records how the result was produced so downstream code (and the
 * LLM scratchpad) can distinguish a confirmed not-enrolled state from a
 * partial probe that timed out before it could rule MDM enrollment in or out.
 */
type ResultSource = "full" | "fast-path" | "timeout" | "error";

interface MdmEnrollmentResult {
  isEnrolled:          boolean;
  mdmProvider:         string | null;
  enrollmentType:      EnrollmentType;
  serverUrl:           string | null;
  supervised:          boolean | null;
  lastCheckinAttempt:  string | null;
  source:              ResultSource;
}

function emptyResult(source: ResultSource): MdmEnrollmentResult {
  return {
    isEnrolled:         false,
    mdmProvider:        null,
    enrollmentType:     "none",
    serverUrl:          null,
    supervised:         null,
    lastCheckinAttempt: null,
    source,
  };
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    {
      maxBuffer:  20 * 1024 * 1024,
      timeout:    EXEC_TIMEOUT_MS,
      killSignal: EXEC_KILL_SIGNAL,
    },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function checkMdmEnrollmentDarwin(): Promise<MdmEnrollmentResult> {
  const result = emptyResult("fast-path");

  // 1. profiles status -type enrollment — fast, no sudo, available on all Macs
  try {
    const { stdout } = await execAsync(
      "profiles status -type enrollment 2>/dev/null",
      {
        maxBuffer:  1024 * 1024,
        timeout:    EXEC_TIMEOUT_MS,
        killSignal: EXEC_KILL_SIGNAL,
      },
    );
    const enrollmentLine = stdout.split("\n").find((l) => /MDM enrollment/i.test(l)) ?? "";
    if (/Yes/i.test(enrollmentLine)) {
      result.isEnrolled     = true;
      result.enrollmentType = /User Approved/i.test(enrollmentLine)
        ? "user_approved"
        : "device_enrollment";
    }
  } catch {
    // profiles not available or permission denied — fall through to other probes
  }

  // 2. sudo -n profiles show -type enrollment (more details).
  //    `-n` is critical: if cached sudo credentials aren't present, sudo exits
  //    immediately rather than prompting for a password on a non-existent TTY
  //    (which is what was hanging the call for the full 30 s tool timeout).
  try {
    const { stdout } = await execAsync(
      "sudo -n profiles show -type enrollment 2>/dev/null",
      {
        maxBuffer:  2 * 1024 * 1024,
        timeout:    EXEC_TIMEOUT_MS,
        killSignal: EXEC_KILL_SIGNAL,
      },
    );

    const urlMatch = stdout.match(/ServerURL\s*=\s*"?([^";\n]+)/i);
    if (urlMatch) result.serverUrl = urlMatch[1].trim();

    if (!result.mdmProvider && result.serverUrl) {
      if (/jamf/i.test(result.serverUrl))            result.mdmProvider = "Jamf";
      if (/intune|microsoft/i.test(result.serverUrl)) result.mdmProvider = "Microsoft Intune";
      if (/apple/i.test(result.serverUrl))           result.mdmProvider = "Apple MDM";
      if (!result.mdmProvider)                       result.mdmProvider = result.serverUrl;
    }

    const checkinMatch = stdout.match(/LastCheckin\s*=\s*([^\n;]+)/i);
    if (checkinMatch) result.lastCheckinAttempt = checkinMatch[1].trim();

    // Reaching this branch means sudo ran — promote the source label.
    result.source = "full";
  } catch {
    // sudo -n failed (no cached creds) OR profiles failed — keep best-effort
    // data from step 1.  Not an error; just less detail.
  }

  // 3. Check Jamf specifically (only if not already identified).
  if (!result.mdmProvider) {
    try {
      const { stdout } = await execAsync(
        "jamf checkJSSConnection 2>/dev/null",
        {
          maxBuffer:  1024 * 1024,
          timeout:    EXEC_TIMEOUT_MS,
          killSignal: EXEC_KILL_SIGNAL,
        },
      );
      if (/successfully/i.test(stdout) || /connected/i.test(stdout)) {
        result.isEnrolled  = true;
        result.mdmProvider = "Jamf";
        const urlMatch = stdout.match(/https?:\/\/[^\s]+/);
        if (urlMatch && !result.serverUrl) result.serverUrl = urlMatch[0];
      }
    } catch {
      // jamf binary not installed — expected on most non-MDM machines
    }
  }

  // 4. system_profiler for supervision status
  try {
    const { stdout } = await execAsync(
      "system_profiler SPConfigurationProfileDataType -json 2>/dev/null",
      {
        maxBuffer:  5 * 1024 * 1024,
        timeout:    EXEC_TIMEOUT_MS,
        killSignal: EXEC_KILL_SIGNAL,
      },
    );
    if (stdout.trim()) {
      const parsed = JSON.parse(stdout) as {
        SPConfigurationProfileDataType?: Array<{ _supervised?: boolean }>;
      };
      const profiles = parsed.SPConfigurationProfileDataType ?? [];
      if (profiles.length > 0) {
        result.isEnrolled = true;
        result.supervised = profiles[0]._supervised ?? null;
        if (!result.mdmProvider) result.mdmProvider = "Unknown MDM";
      }
    }
  } catch {
    // system_profiler may fail or return empty — best effort
  }

  if (!result.isEnrolled) result.enrollmentType = "none";
  return result;
}

// -- win32 implementation -----------------------------------------------------

async function checkMdmEnrollmentWin32(): Promise<MdmEnrollmentResult> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$enrollments = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Enrollments' -ErrorAction SilentlyContinue |
               Get-ItemProperty -ErrorAction SilentlyContinue |
               Select-Object UPN,ProviderID,EnrollmentState,DiscoveryServiceFullURL
if ($enrollments) { @($enrollments) | ConvertTo-Json -Depth 2 -Compress } else { '[]' }`.trim();

  const result = emptyResult("full");

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
      result.isEnrolled     = true;
      result.enrollmentType = "device_enrollment";
      result.mdmProvider    = active[0].ProviderID ?? null;
      result.serverUrl      = active[0].DiscoveryServiceFullURL ?? null;

      if (result.mdmProvider) {
        if (/intune|microsoft/i.test(result.mdmProvider)) result.mdmProvider = "Microsoft Intune";
        if (/jamf/i.test(result.mdmProvider))             result.mdmProvider = "Jamf";
      } else if (result.serverUrl) {
        if (/intune|microsoft/i.test(result.serverUrl)) result.mdmProvider = "Microsoft Intune";
        if (/jamf/i.test(result.serverUrl))             result.mdmProvider = "Jamf";
      }
    }
  } catch {
    // Registry access failed or PowerShell hit its internal exec timeout.
    result.source = "error";
  }

  return result;
}

// -- Top-level race -----------------------------------------------------------
//
// Defence-in-depth: even if every individual exec respects its 5 s timeout,
// the platform implementation must still settle within OVERALL_BUDGET_MS so
// the tool never trips G4's 30 s global gate.  When the race fires, downstream
// code sees `source: "timeout"` and treats the device as not-enrolled, which
// is the correct conservative default for the software-reinstall workflow.

function withOverallBudget<T extends MdmEnrollmentResult>(
  work:    Promise<T>,
  budget:  number,
): Promise<MdmEnrollmentResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(emptyResult("timeout"));
    }, budget);
    work.then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(emptyResult("error"));
      },
    );
  });
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();
  const work = platform === "win32"
    ? checkMdmEnrollmentWin32()
    : checkMdmEnrollmentDarwin();
  return withOverallBudget(work, __testing.budgetMs);
}

/**
 * Test-only knob — lets unit tests assert the overall-budget race fires
 * without waiting 8 s of wall-clock time.  Production code never imports
 * this; the runtime simply reads `__testing.budgetMs` once per call.
 */
export const __testing = { budgetMs: OVERALL_BUDGET_MS };

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
