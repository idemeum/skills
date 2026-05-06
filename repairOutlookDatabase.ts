/**
 * mcp/skills/repairOutlookDatabase.ts — repair_outlook_database skill
 *
 * Locates and prepares to run the Microsoft Outlook database repair utility.
 * On macOS, identifies the Outlook Database Utility or Profile Manager.
 * On Windows, locates scanpst.exe.
 * Use when Outlook crashes, hangs, or shows data corruption errors.
 *
 * Platform strategy
 * -----------------
 * darwin  Checks /Applications/Microsoft Outlook.app/Contents/SharedSupport/
 *         and ~/Library/Group Containers/UBF8T346G9.Office/ for profile data.
 * win32   Searches common scanpst.exe paths and PST/OST files via PowerShell.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/repairOutlookDatabase.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import * as fs       from "fs/promises";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "repair_outlook_database",
  description:
    "Locates and prepares to run the Microsoft Outlook database repair utility. " +
    "On macOS, identifies the Outlook Database Utility or Profile Manager. " +
    "On Windows, locates scanpst.exe. " +
    "Use when Outlook crashes, hangs, or shows data corruption errors.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, locate repair tool and database files without running repair. Default: true",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RepairOutlookResult {
  toolFound:       boolean;
  toolPath:        string | null;
  databaseFiles:   string[];
  outlookRunning:  boolean;
  dryRun:          boolean;
  message:         string;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function repairOutlookDarwin(dryRun: boolean): Promise<RepairOutlookResult> {
  // Check if Outlook is running
  let outlookRunning = false;
  try {
    const { stdout } = await execAsync("pgrep -x 'Microsoft Outlook'", { timeout: 3_000 });
    outlookRunning = stdout.trim().length > 0;
  } catch {
    outlookRunning = false;
  }

  // Search for Outlook Database Utility
  const sharedSupportDir =
    "/Applications/Microsoft Outlook.app/Contents/SharedSupport";
  let toolPath: string | null = null;

  const candidateTools = [
    nodePath.join(sharedSupportDir, "Outlook Database Utility.app"),
    nodePath.join(sharedSupportDir, "Outlook Profile Manager.app"),
  ];

  for (const candidate of candidateTools) {
    try {
      await fs.access(candidate);
      toolPath = candidate;
      break;
    } catch {
      // Not found — try next
    }
  }

  // Look for profile/database data
  const profileBase = nodePath.join(
    os.homedir(),
    "Library",
    "Group Containers",
    "UBF8T346G9.Office",
  );
  const databaseFiles: string[] = [];

  try {
    // Check if the base directory exists
    await fs.access(profileBase);
    databaseFiles.push(profileBase);

    // Also look for specific database files
    const outlookDataDir = nodePath.join(
      profileBase,
      "Outlook",
      "Outlook 15 Profiles",
    );
    try {
      await fs.access(outlookDataDir);
      databaseFiles.push(outlookDataDir);
    } catch {
      // Sub-directory may not exist
    }
  } catch {
    // Group container not found — Outlook may not be installed
  }

  // Open the repair tool if requested
  if (!dryRun && toolPath) {
    try {
      await execAsync(`open "${toolPath}"`, { timeout: 5_000 });
    } catch {
      // Non-fatal
    }
  }

  const message = dryRun
    ? toolPath
      ? `Found repair tool at: ${toolPath}. Run with dryRun=false to open it.`
      : "Outlook repair tool not found. Ensure Microsoft Outlook is installed."
    : toolPath
      ? `Opened repair tool: ${toolPath}`
      : "Outlook repair tool not found — cannot run repair automatically.";

  return { toolFound: toolPath !== null, toolPath, databaseFiles, outlookRunning, dryRun, message };
}

// -- win32 implementation -----------------------------------------------------

async function repairOutlookWin32(dryRun: boolean): Promise<RepairOutlookResult> {
  // Check if Outlook is running
  let outlookRunning = false;
  try {
    const raw = await runPS(
      `$ErrorActionPreference='SilentlyContinue'; (Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue) -ne $null`,
    );
    outlookRunning = raw.trim().toLowerCase() === "true";
  } catch {
    outlookRunning = false;
  }

  // Search common scanpst.exe paths
  const scanPstCandidates = [
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\SCANPST.EXE",
    "C:\\Program Files\\Microsoft Office\\root\\Office15\\SCANPST.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\SCANPST.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\root\\Office15\\SCANPST.EXE",
    "C:\\Program Files\\Microsoft Office\\Office16\\SCANPST.EXE",
    "C:\\Program Files\\Microsoft Office\\Office15\\SCANPST.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\Office16\\SCANPST.EXE",
    "C:\\Program Files (x86)\\Microsoft Office\\Office15\\SCANPST.EXE",
  ];

  let toolPath: string | null = null;
  for (const candidate of scanPstCandidates) {
    try {
      await fs.access(candidate);
      toolPath = candidate;
      break;
    } catch {
      // Not found — try next
    }
  }

  // Find PST/OST files via PowerShell
  let databaseFiles: string[] = [];
  try {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-ChildItem -Path "$env:LOCALAPPDATA\\Microsoft\\Outlook" -Include *.pst,*.ost -Recurse |
  Select-Object -ExpandProperty FullName | ConvertTo-Json -Compress`.trim();
    const raw = await runPS(ps);
    if (raw) {
      const parsed = JSON.parse(raw) as string | string[];
      databaseFiles = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    databaseFiles = [];
  }

  const message = dryRun
    ? toolPath
      ? `Found scanpst.exe at: ${toolPath}. Found ${databaseFiles.length} data file(s). Run with dryRun=false to open the repair tool.`
      : `scanpst.exe not found in standard locations. Found ${databaseFiles.length} data file(s).`
    : toolPath
      ? `Repair tool located: ${toolPath}. Run the tool manually against the .pst/.ost files listed in databaseFiles.`
      : "scanpst.exe not found — install or repair Microsoft Office to restore the tool.";

  return { toolFound: toolPath !== null, toolPath, databaseFiles, outlookRunning, dryRun, message };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? repairOutlookWin32(dryRun)
    : repairOutlookDarwin(dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
