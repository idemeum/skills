/**
 * mcp/skills/disableStartupItem.ts — disable_startup_item skill
 *
 * Removes an application from the login items list so it no longer launches
 * at startup. Does not uninstall the application. Defaults to dry-run.
 *
 * Platform strategy
 * -----------------
 * darwin  osascript to delete login item; fallback: remove plist from LaunchAgents
 * win32   PowerShell remove from HKCU Run registry key
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/disableStartupItem.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";
import * as fs       from "fs/promises";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "disable_startup_item",
  description:
    "Removes an application from the login items list so it no longer launches " +
    "at startup. Use to reduce boot time or stop unwanted background apps. " +
    "Does not uninstall the application.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    name: z
      .string()
      .describe("Exact name of the startup item to disable"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, show what would be removed without removing. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface DisableResult {
  name:     string;
  found:    boolean;
  disabled: boolean;
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

async function disableStartupItemDarwin(
  name:   string,
  dryRun: boolean,
): Promise<DisableResult> {
  const safeName = name.replace(/'/g, `'\\''`);

  // 1. Try osascript login items first
  let found = false;
  try {
    const { stdout } = await execAsync(
      `osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null`,
      { maxBuffer: 1024 * 1024 },
    );
    const names = stdout.trim().split(", ").map(s => s.trim());
    found = names.some(n => n.toLowerCase() === name.toLowerCase());
  } catch {
    // osascript unavailable
  }

  if (found) {
    if (dryRun) {
      return { name, found: true, disabled: false, dryRun: true, message: `Dry run: would remove login item '${name}'.` };
    }
    try {
      await execAsync(
        `osascript -e 'tell application "System Events" to delete login item "${safeName}"' 2>/dev/null`,
        { maxBuffer: 1024 * 1024 },
      );
      return { name, found: true, disabled: true, dryRun: false, message: `Login item '${name}' removed.` };
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      return { name, found: true, disabled: false, dryRun: false, message: `Failed to remove login item: ${msg}` };
    }
  }

  // 2. Fallback: search LaunchAgents plist
  const home       = os.homedir();
  const agentDir   = nodePath.join(home, "Library", "LaunchAgents");
  const plistName  = `${name}.plist`;
  const plistPath  = nodePath.join(agentDir, plistName);

  let plistExists = false;
  try {
    await fs.access(plistPath);
    plistExists = true;
  } catch {
    // not found
  }

  if (!plistExists) {
    return { name, found: false, disabled: false, dryRun, message: `No login item or LaunchAgent named '${name}' found.` };
  }

  if (dryRun) {
    return { name, found: true, disabled: false, dryRun: true, message: `Dry run: would remove LaunchAgent plist '${plistPath}'.` };
  }

  try {
    await fs.unlink(plistPath);
    return { name, found: true, disabled: true, dryRun: false, message: `LaunchAgent plist '${plistPath}' removed.` };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { name, found: true, disabled: false, dryRun: false, message: `Failed to remove plist: ${msg}` };
  }
}

// -- win32 implementation -----------------------------------------------------

async function disableStartupItemWin32(
  name:   string,
  dryRun: boolean,
): Promise<DisableResult> {
  const safeName = name.replace(/'/g, "''");
  const checkPs  = `
$key = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
if ($key -and $key.PSObject.Properties['${safeName}']) { 'found' } else { 'notfound' }`.trim();

  const checkResult = await runPS(checkPs);
  const found       = checkResult.trim() === "found";

  if (!found) {
    return { name, found: false, disabled: false, dryRun, message: `No Run key entry named '${name}' found in HKCU.` };
  }

  if (dryRun) {
    return { name, found: true, disabled: false, dryRun: true, message: `Dry run: would remove HKCU Run entry '${name}'.` };
  }

  try {
    await runPS(`Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${safeName}' -ErrorAction Stop`);
    return { name, found: true, disabled: true, dryRun: false, message: `Run key entry '${name}' removed from HKCU.` };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    return { name, found: true, disabled: false, dryRun: false, message: `Failed to remove registry entry: ${msg}` };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  name,
  dryRun = true,
}: {
  name:    string;
  dryRun?: boolean;
}): Promise<DisableResult> {
  if (!name || !name.trim()) {
    throw new Error("[disable_startup_item] 'name' is required and must not be empty.");
  }

  const platform = os.platform();
  if (platform === "win32") {
    return disableStartupItemWin32(name, dryRun);
  }
  return disableStartupItemDarwin(name, dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ name: "SomeApp" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
