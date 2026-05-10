/**
 * mcp/skills/findOldDownloads.ts — find_old_downloads skill
 *
 * Lists files in the Downloads folder that haven't been accessed or modified
 * in a specified number of days. Use to identify stale downloads that can be
 * safely deleted to recover disk space.
 *
 * Platform strategy
 * -----------------
 * Both   Pure Node.js — fs.readdirSync on ~/Downloads, stat each file,
 *        filter by mtimeMs and size. Cross-platform, no shell needed.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/findOldDownloads.ts
 */

import * as fsp      from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { z }         from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "find_old_downloads",
  description:
    "Lists files in the Downloads folder that haven't been accessed or modified " +
    "in a specified number of days. Use to identify stale downloads that can be " +
    "safely deleted to recover disk space.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    olderThanDays: z
      .number()
      .optional()
      .describe("Return files not modified in this many days. Default: 90"),
    minSizeMb: z
      .number()
      .optional()
      .describe("Minimum file size in MB. Default: 0 (all files)"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface OldFile {
  name:              string;
  path:              string;
  sizeMb:            number;
  lastModified:      string; // ISO 8601
  daysSinceModified: number;
}

// -- Exported run function ----------------------------------------------------

export async function run({
  olderThanDays = 90,
  minSizeMb     = 0,
}: {
  olderThanDays?: number;
  minSizeMb?:     number;
} = {}) {
  const platform      = os.platform();
  const downloadsPath = nodePath.join(os.homedir(), "Downloads");

  // Ensure Downloads folder exists
  try {
    await fsp.access(downloadsPath);
  } catch {
    return {
      platform,
      downloadsPath,
      totalFiles:  0,
      oldFiles:    [] as OldFile[],
      totalSizeMb: 0,
      message:     `Downloads folder not found at: ${downloadsPath}`,
    };
  }

  const now        = Date.now();
  const cutoffMs   = olderThanDays * 24 * 60 * 60 * 1000;
  const minBytes   = minSizeMb * 1024 * 1024;

  let dirents: import("fs").Dirent[];
  try {
    dirents = await fsp.readdir(downloadsPath, { withFileTypes: true });
  } catch (err) {
    // Distinguish TCC denial from genuinely-missing folder so the user
    // sees an actionable remediation path rather than a generic error.
    const code = (err as { code?: string }).code;
    if (code === "EPERM" || code === "EACCES") {
      return {
        platform,
        downloadsPath,
        totalFiles:  0,
        oldFiles:    [] as OldFile[],
        totalSizeMb: 0,
        error:
          "Cannot read Downloads folder — macOS denied access. " +
          "Open System Settings → Privacy & Security → Files and Folders, " +
          "find AI Support Agent, and enable the Downloads Folder checkbox. " +
          "Alternatively, grant Full Disk Access. Then quit and relaunch AI Support Agent.",
      };
    }
    throw new Error(`[find_old_downloads] Cannot read Downloads folder: ${(err as Error).message}`);
  }

  // Only look at files in the top-level Downloads directory
  const fileEntries = dirents.filter((d) => d.isFile());
  const totalFiles  = fileEntries.length;

  const settled = await Promise.allSettled(
    fileEntries.map(async (d): Promise<OldFile | null> => {
      const full = nodePath.join(downloadsPath, d.name);
      try {
        const stat          = await fsp.stat(full);
        const ageMs         = now - stat.mtimeMs;
        const daysSinceMod  = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        if (ageMs < cutoffMs) return null;
        if (stat.size < minBytes) return null;
        return {
          name:              d.name,
          path:              full,
          sizeMb:            Math.round((stat.size / (1024 * 1024)) * 100) / 100,
          lastModified:      stat.mtime.toISOString(),
          daysSinceModified: daysSinceMod,
        };
      } catch {
        return null;
      }
    }),
  );

  const oldFiles = settled
    .filter((r): r is PromiseFulfilledResult<OldFile | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((f): f is OldFile => f !== null)
    .sort((a, b) => b.sizeMb - a.sizeMb);

  const totalSizeMb = Math.round(
    oldFiles.reduce((s, f) => s + f.sizeMb, 0) * 100,
  ) / 100;

  return {
    platform,
    downloadsPath,
    totalFiles,
    oldFiles,
    totalSizeMb,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
