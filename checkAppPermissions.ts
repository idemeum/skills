/**
 * mcp/skills/checkAppPermissions.ts — check_app_permissions skill
 *
 * Checks what system permissions an application has been granted (Full Disk
 * Access, Accessibility, Camera, Microphone, etc.). Use before reinstalling
 * software or when an app reports permission errors.
 *
 * Platform strategy
 * -----------------
 * darwin  sqlite3 query against ~/Library/Application Support/com.apple.TCC/TCC.db
 * win32   PowerShell registry query HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkAppPermissions.ts "CrowdStrike Falcon"
 */

import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_app_permissions",
  description:
    "Checks what system permissions an application has been granted " +
    "(Full Disk Access, Accessibility, Camera, Microphone, etc.). " +
    "Use before reinstalling software or when an app reports permission errors.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    appName: z
      .string()
      .describe("Application name to check (e.g. 'CrowdStrike Falcon', 'Jamf Connect')"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface PermissionEntry {
  category: string;
  status:   "allowed" | "denied" | "unknown";
}

interface PermissionsResult {
  appName:     string;
  platform:    string;
  permissions: PermissionEntry[];
  error?:      string;
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

// TCC privacy category service names -> human-readable labels
const TCC_CATEGORIES: Record<string, string> = {
  kTCCServiceSystemPolicyAllFiles:    "Full Disk Access",
  kTCCServiceAccessibility:           "Accessibility",
  kTCCServiceCamera:                  "Camera",
  kTCCServiceMicrophone:              "Microphone",
  kTCCServiceCalendar:                "Calendar",
  kTCCServiceAddressBook:             "Contacts",
  kTCCServicePhotos:                  "Photos",
  kTCCServiceScreenCapture:           "Screen Recording",
  kTCCServiceLocation:                "Location",
  kTCCServiceBluetoothAlways:         "Bluetooth",
  kTCCServiceUserAvailability:        "Focus Status",
  kTCCServiceAppleEvents:             "Automation",
  kTCCServiceSystemPolicySysAdminFiles: "Administrator Files",
  kTCCServiceSpeechRecognition:       "Speech Recognition",
  kTCCServiceMediaLibrary:            "Media Library",
  kTCCServiceReminders:               "Reminders",
  kTCCServiceLiverpool:               "Location Services",
  kTCCServiceShareKit:                "Share Menu",
  kTCCServicePostEvent:               "Input Monitoring",
};

async function checkAppPermissionsDarwin(appName: string): Promise<PermissionsResult> {
  // Security: validate appName before using in shell
  if (!/^[a-zA-Z0-9 _\-.']+$/.test(appName)) {
    throw new Error(`[check_app_permissions] Invalid appName: ${appName}`);
  }

  const tccDb = nodePath.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.apple.TCC",
    "TCC.db",
  );

  const safeAppName = appName.replace(/'/g, "''");
  // Query TCC.db for entries where client (bundle ID) or policy_id contains the app name
  const query = `SELECT service, client, auth_value FROM access WHERE LOWER(client) LIKE LOWER('%${safeAppName}%') OR LOWER(policy_id) LIKE LOWER('%${safeAppName}%');`;

  try {
    const { stdout } = await execAsync(
      `sqlite3 '${tccDb.replace(/'/g, "'\\''")}' "${query}" 2>&1`,
      { maxBuffer: 5 * 1024 * 1024 },
    );

    const rows = stdout.trim().split("\n").filter(Boolean);

    if (rows.length === 0) {
      return {
        appName,
        platform:    "darwin",
        permissions: [],
        error:       "No TCC entries found for this application. App may not have requested permissions yet, or requires elevated access to read system TCC database.",
      };
    }

    const permissions: PermissionEntry[] = rows.map((row) => {
      const parts     = row.split("|");
      const service   = parts[0] ?? "";
      const authValue = parseInt(parts[2] ?? "0", 10);
      // auth_value: 0 = denied, 2 = allowed, 3 = limited/not determined
      const status: PermissionEntry["status"] =
        authValue === 2 ? "allowed" :
        authValue === 0 ? "denied"  :
        "unknown";
      return {
        category: TCC_CATEGORIES[service] ?? service,
        status,
      };
    });

    return { appName, platform: "darwin", permissions };
  } catch (err) {
    // System TCC.db may require Full Disk Access — try system-level db
    const systemTccDb = "/Library/Application Support/com.apple.TCC/TCC.db";
    try {
      const { stdout } = await execAsync(
        `sqlite3 '${systemTccDb}' "${query}" 2>&1`,
        { maxBuffer: 5 * 1024 * 1024 },
      );
      const rows = stdout.trim().split("\n").filter(Boolean);
      const permissions: PermissionEntry[] = rows.map((row) => {
        const parts     = row.split("|");
        const service   = parts[0] ?? "";
        const authValue = parseInt(parts[2] ?? "0", 10);
        const status: PermissionEntry["status"] =
          authValue === 2 ? "allowed" :
          authValue === 0 ? "denied"  :
          "unknown";
        return { category: TCC_CATEGORIES[service] ?? service, status };
      });
      return { appName, platform: "darwin", permissions };
    } catch {
      return {
        appName,
        platform:    "darwin",
        permissions: [],
        error:       `Could not read TCC database: ${(err as Error).message}. Full Disk Access may be required.`,
      };
    }
  }
}

// -- win32 implementation -----------------------------------------------------

const WIN_CAPABILITIES = [
  "webcam",
  "microphone",
  "location",
  "contacts",
  "calendar",
  "phoneCall",
  "email",
  "appointments",
  "userAccountInformation",
  "radios",
  "bluetoothSync",
  "appDiagnostics",
  "gazeInput",
  "broadFileSystemAccess",
];

async function checkAppPermissionsWin32(appName: string): Promise<PermissionsResult> {
  if (!/^[a-zA-Z0-9 _\-.']+$/.test(appName)) {
    throw new Error(`[check_app_permissions] Invalid appName: ${appName}`);
  }

  const safeApp = appName.replace(/'/g, "''");
  const caps    = WIN_CAPABILITIES.map((c) => `'${c}'`).join(",");

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$basePath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore'
$results = @()
foreach ($cap in @(${caps})) {
  $capPath = "$basePath\\$cap"
  if (Test-Path $capPath) {
    $apps = Get-ChildItem -Path $capPath -ErrorAction SilentlyContinue
    foreach ($app in $apps) {
      if ($app.PSChildName -like "*${safeApp}*") {
        $val = (Get-ItemProperty -Path $app.PSPath -Name 'Value' -ErrorAction SilentlyContinue).Value
        $results += [PSCustomObject]@{
          category = $cap
          status   = if ($val -eq 'Allow') { 'allowed' } elseif ($val -eq 'Deny') { 'denied' } else { 'unknown' }
        }
      }
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress`.trim();

  try {
    const raw = await runPS(ps);
    if (!raw || raw === "null") {
      return { appName, platform: "win32", permissions: [], error: "No capability entries found for this application." };
    }
    const parsed      = JSON.parse(raw) as PermissionEntry | PermissionEntry[];
    const permissions = Array.isArray(parsed) ? parsed : [parsed];
    return { appName, platform: "win32", permissions };
  } catch (err) {
    return {
      appName,
      platform:    "win32",
      permissions: [],
      error:       (err as Error).message,
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({ appName }: { appName: string }) {
  const platform = os.platform();
  return platform === "win32"
    ? checkAppPermissionsWin32(appName)
    : checkAppPermissionsDarwin(appName);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ appName: process.argv[2] ?? "Slack" })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
