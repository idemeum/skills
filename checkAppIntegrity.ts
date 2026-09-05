/**
 * mcp/skills/checkAppIntegrity.ts — check_app_integrity skill
 *
 * Verifies the code signature and Gatekeeper approval of an installed
 * application. A failed signature indicates corruption or tampering requiring
 * reinstallation. Use before reinstalling to confirm integrity is the issue.
 *
 * Platform strategy
 * -----------------
 * darwin  `codesign --verify` and `spctl --assess`
 * win32   PowerShell Get-AuthenticodeSignature
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkAppIntegrity.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_app_integrity",
  description:
    "Verifies the code signature and Gatekeeper approval of an installed application. " +
    "A failed signature indicates corruption or tampering requiring reinstallation. " +
    "Use before reinstalling to confirm integrity is the issue.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["appName","appPath","found","signatureValid","gateKeeperApproved","details","recommendation"],
  schema: {
    appName: z
      .string()
      .nullable().optional()
      .describe("Application name (e.g. 'Zoom', 'Slack')"),
    appPath: z
      .string()
      .nullable().optional()
      .describe(
        "Full path to .app bundle. If omitted, searches /Applications and ~/Applications",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface AppIntegrityResult {
  appName:            string;
  appPath:            string | null;
  found:              boolean;
  signatureValid:     boolean | null;
  gateKeeperApproved: boolean | null;
  details:            string;
  recommendation:     string;
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

async function findAppDarwin(appName: string): Promise<string | null> {
  const safeName = appName.replace(/'/g, `'\\''`);
  try {
    const { stdout } = await execAsync(
      `find /Applications ~/Applications -maxdepth 2 -name '${safeName}.app' 2>/dev/null`,
      { maxBuffer: 1024 * 1024, shell: "/bin/bash" },
    );
    const first = stdout.trim().split("\n")[0];
    return first || null;
  } catch {
    return null;
  }
}

async function checkAppIntegrityDarwin(
  appName?: string,
  appPath?: string,
): Promise<AppIntegrityResult> {
  let resolvedPath: string | null = appPath ?? null;
  const resolvedName              = appName ?? (appPath ? appPath.split("/").at(-1)?.replace(/\.app$/, "") ?? "Unknown" : "Unknown");

  if (!resolvedPath && appName) {
    resolvedPath = await findAppDarwin(appName);
  }

  if (!resolvedPath) {
    return {
      appName:            resolvedName,
      appPath:            null,
      found:              false,
      signatureValid:     null,
      gateKeeperApproved: null,
      details:            `Application "${resolvedName}" not found in /Applications or ~/Applications`,
      recommendation:     "Verify the application name or install the application first.",
    };
  }

  const safePath = resolvedPath.replace(/'/g, `'\\''`);
  let signatureValid     = false;
  let gateKeeperApproved = false;
  let signatureDetails   = "";
  let gatekeeperDetails  = "";

  // Code signature check.
  //
  // Plain `--verify`, deliberately: it validates the seal, which is the
  // question being asked — has this bundle been altered since it was signed.
  //
  // `--deep --strict` answers a stricter question and fails legitimately
  // signed apps. Observed 2026-09-05: /Applications/zoom.us.app passes
  // `codesign -v` ("valid on disk", "satisfies its Designated Requirement",
  // exit 0) and fails `--verify --deep --strict` with "resource fork, Finder
  // information, or similar detritus not allowed" — stray extended attributes
  // that a copy or a download leaves behind. Cosmetic, and near-universal.
  //
  // The cost of getting this wrong is not a mislabelled field.
  // software-reinstall reads `signatureValid: false` as "the bundle is
  // corrupt, resets cannot help", skips its entire non-destructive branch and
  // goes to `uninstall_app`. A false negative here uninstalls a working
  // application.
  //
  // Note also what is NOT redirected: piping stderr into stdout left
  // `err.stderr` empty, so the verdict arrived with its reason missing —
  // "Code signature invalid: " and nothing after it.
  try {
    await execAsync(
      `codesign --verify --verbose=2 '${safePath}'`,
      { maxBuffer: 1024 * 1024, shell: "/bin/bash" },
    );
    signatureValid   = true;
    signatureDetails = "Code signature is valid.";
  } catch (err) {
    const e      = err as { stderr?: string; stdout?: string };
    const reason = (e.stderr ?? "").trim() || (e.stdout ?? "").trim() || (err as Error).message;
    signatureValid   = false;
    signatureDetails = `Code signature invalid: ${reason}`;
  }

  // Gatekeeper check
  try {
    const { stdout, stderr } = await execAsync(
      `spctl --assess --type execute '${safePath}' 2>&1`,
      { maxBuffer: 1024 * 1024, shell: "/bin/bash" },
    );
    const combined        = (stdout + stderr).toLowerCase();
    gateKeeperApproved    = !combined.includes("rejected") && !combined.includes("not accepted");
    gatekeeperDetails     = gateKeeperApproved ? "Gatekeeper approved." : `Gatekeeper rejected: ${stdout.trim() || stderr.trim()}`;
  } catch (err) {
    gateKeeperApproved = false;
    gatekeeperDetails  = `Gatekeeper check failed: ${(err as Error).message}`;
  }

  const details        = [signatureDetails, gatekeeperDetails].join(" ");
  const recommendation = signatureValid && gateKeeperApproved
    ? "Application integrity is intact. No reinstall needed."
    : "Application integrity check failed. Reinstall is recommended for a clean state.";

  return {
    appName:     resolvedName,
    appPath:     resolvedPath,
    found:       true,
    signatureValid,
    gateKeeperApproved,
    details,
    recommendation,
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkAppIntegrityWin32(
  appName?: string,
  appPath?: string,
): Promise<AppIntegrityResult> {
  const resolvedName = appName ?? "Unknown";

  // On Windows, try to find the exe if no path given
  let exePath = appPath ?? null;
  if (!exePath && appName) {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$app = Get-Package -Name '*${appName}*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($app) { $app.Source } else { '' }`.trim();
    try {
      const raw = await runPS(ps);
      exePath   = raw.trim() || null;
    } catch {
      exePath = null;
    }
  }

  if (!exePath) {
    return {
      appName:            resolvedName,
      appPath:            null,
      found:              false,
      signatureValid:     null,
      gateKeeperApproved: null,
      details:            `Application "${resolvedName}" not found`,
      recommendation:     "Verify the application name or provide the full executable path.",
    };
  }

  const safeExePath = exePath.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$sig = Get-AuthenticodeSignature -FilePath '${safeExePath}' |
       Select-Object Status,StatusMessage,SignerCertificate
$sig | ConvertTo-Json -Compress`.trim();

  let signatureValid = false;
  let details        = "";
  try {
    const raw    = await runPS(ps);
    const parsed = JSON.parse(raw) as {
      Status:            string;
      StatusMessage:     string;
      SignerCertificate: unknown;
    };
    signatureValid = parsed.Status === "Valid";
    details        = `Signature status: ${parsed.Status}. ${parsed.StatusMessage ?? ""}`;
  } catch (err) {
    details = `Error checking signature: ${(err as Error).message}`;
  }

  const recommendation = signatureValid
    ? "Authenticode signature is valid. Application integrity intact."
    : "Authenticode signature check failed. Reinstall is recommended.";

  return {
    appName:            resolvedName,
    appPath:            exePath,
    found:              true,
    signatureValid,
    gateKeeperApproved: null,
    details,
    recommendation,
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  appName,
  appPath,
}: {
  appName?: string;
  appPath?: string;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkAppIntegrityWin32(appName, appPath)
    : checkAppIntegrityDarwin(appName, appPath);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ appName: "Zoom" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
