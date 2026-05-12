/**
 * mcp/skills/rebuildMailIndex.ts — rebuild_mail_index skill
 *
 * Triggers Apple Mail mailbox index rebuild by removing the envelope index
 * file, forcing Mail to rebuild on next launch.  Use when Mail is slow,
 * showing wrong message counts, or missing messages.
 *
 * Platform strategy
 * -----------------
 * darwin  Removes ~/Library/Mail/V10/MailData/Envelope Index (+ -shm, -wal)
 *         after optionally quitting Mail via AppleScript.
 * win32   Not supported — Apple Mail is macOS only.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/rebuildMailIndex.ts
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
  name: "rebuild_mail_index",
  description:
    "Triggers Apple Mail mailbox index rebuild by removing the envelope index " +
    "file, forcing Mail to rebuild on next launch. " +
    "Use when Mail is slow, showing wrong message counts, or missing messages. " +
    "macOS only.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  tccCategories:   ["FullDiskAccess", "Automation"],
  schema: {
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, show what would be removed without removing. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RebuildMailIndexResult {
  filesFound:      string[];
  filesRemoved:    string[];
  mailWasRunning:  boolean;
  dryRun:          boolean;
  message:         string;
}

// -- darwin implementation ----------------------------------------------------

async function rebuildMailIndexDarwin(dryRun: boolean): Promise<RebuildMailIndexResult> {
  const home = os.homedir();

  // Check if Mail is running
  let mailWasRunning = false;
  try {
    const { stdout } = await execAsync("pgrep -x Mail", { timeout: 3_000 });
    mailWasRunning = stdout.trim().length > 0;
  } catch {
    // pgrep exits 1 if no match — Mail not running
    mailWasRunning = false;
  }

  // Quit Mail if running
  if (mailWasRunning && !dryRun) {
    try {
      await execAsync("osascript -e 'tell application \"Mail\" to quit'", { timeout: 10_000 });
      // Brief pause to let Mail finish writing
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch {
      // Non-fatal — continue even if quit fails
    }
  }

  // Find envelope index files — try V10, V9, V8 in order
  const filesFound: string[] = [];
  for (const version of ["V10", "V9", "V8"]) {
    const baseDir  = nodePath.join(home, "Library", "Mail", version, "MailData");
    const variants = [
      nodePath.join(baseDir, "Envelope Index"),
      nodePath.join(baseDir, "Envelope Index-shm"),
      nodePath.join(baseDir, "Envelope Index-wal"),
    ];
    for (const f of variants) {
      try {
        await fs.access(f);
        filesFound.push(f);
      } catch {
        // File does not exist — skip
      }
    }
    if (filesFound.length > 0) break; // Stop at first version that has files
  }

  const filesRemoved: string[] = [];
  if (!dryRun) {
    for (const f of filesFound) {
      try {
        await fs.unlink(f);
        filesRemoved.push(f);
      } catch (err) {
        // Collect errors but continue
      }
    }
  }

  const message = dryRun
    ? filesFound.length > 0
      ? `Found ${filesFound.length} envelope index file(s). Run with dryRun=false to remove them and trigger a rebuild.`
      : "No envelope index files found. Mail index may already be absent or stored in an unexpected location."
    : filesRemoved.length > 0
      ? `Removed ${filesRemoved.length} file(s). Mail will rebuild its index on next launch.`
      : "No files were removed. Check that Mail is not running and the files exist.";

  return { filesFound, filesRemoved, mailWasRunning, dryRun, message };
}

// -- win32 implementation -----------------------------------------------------

async function rebuildMailIndexWin32(_dryRun: boolean): Promise<RebuildMailIndexResult> {
  return {
    filesFound:     [],
    filesRemoved:   [],
    mailWasRunning: false,
    dryRun:         _dryRun,
    message:
      "Apple Mail is macOS only. For Outlook on Windows, use repair_outlook_database.",
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  dryRun = true,
}: {
  dryRun?: boolean;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? rebuildMailIndexWin32(dryRun)
    : rebuildMailIndexDarwin(dryRun);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
