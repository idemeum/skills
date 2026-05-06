/**
 * mcp/skills/diskScan.ts — disk_scan skill
 *
 * Scans a directory and returns the size of every immediate child entry,
 * sorted largest first.  Helps Claude answer "what is using my disk space?"
 *
 * Platform strategy
 * -----------------
 * darwin  `du -sk <dir>/*` — fast, OS-native, gives recursive dir sizes
 * win32   PowerShell via -EncodedCommand — recursive Measure-Object per child
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/diskScan.ts [/optional/path]
 */

import * as fs       from "fs/promises";
import * as os       from "os";
import * as nodePath from "path";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "disk_scan",
  description:
    "Scans a directory and returns the size of each immediate child entry " +
    "(files and sub-folders), sorted largest first. " +
    "Use when the user wants to find what is consuming disk space.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    path: z
      .string()
      .optional()
      .describe(
        "Absolute path of the directory to scan. " +
        "Defaults to the user home directory.",
      ),
  },
} as const;

// -- Shared helpers -----------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}

interface Entry {
  name:      string;
  path:      string;
  size:      number;
  sizeHuman: string;
  type:      "file" | "directory";
}

// -- PowerShell helper --------------------------------------------------------

export async function runPS(script: string): Promise<string> {
  // -EncodedCommand accepts Base64 UTF-16LE — avoids all shell quoting issues.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

/** Fallback: stat immediate children (used when du output is empty). */
async function statChildren(scanPath: string): Promise<Entry[]> {
  const dirents = await fs.readdir(scanPath, { withFileTypes: true });
  const settled = await Promise.allSettled(
    dirents.map(async (e) => {
      const full = nodePath.join(scanPath, e.name);
      const stat = await fs.stat(full);
      return {
        name:      e.name,
        path:      full,
        size:      stat.size,
        sizeHuman: formatBytes(stat.size),
        type:      (e.isDirectory() ? "directory" : "file") as Entry["type"],
      };
    }),
  );
  return settled
    .filter((r): r is PromiseFulfilledResult<Entry> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => b.size - a.size);
}

async function scanDarwin(scanPath: string): Promise<Entry[]> {
  // du exits non-zero when some children are permission-denied — stdout still useful.
  let stdout = "";
  try {
    // Security: use single-quoted path to prevent shell injection.
    // Single-quoted strings cannot contain command substitution ($(), ``)
    // or variable expansion. Escape any literal single quotes by ending
    // the string, inserting a backslash-quoted ', then restarting.
    const safePath = scanPath.replace(/'/g, `'\\''`);
    ({ stdout } = await execAsync(
      `du -sk '${safePath}'/* 2>/dev/null`,
      { maxBuffer: 20 * 1024 * 1024, shell: "/bin/bash", timeout: 30_000 },
    ));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? "";
  }

  if (!stdout.trim()) return statChildren(scanPath);

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab  = line.indexOf("\t");
      const kb   = parseInt(line.slice(0, tab), 10);
      const full = line.slice(tab + 1).trim();
      const size = kb * 1024; // du -k reports 1024-byte blocks
      return {
        name:      nodePath.basename(full),
        path:      full,
        size,
        sizeHuman: formatBytes(size),
        type:      "directory" as Entry["type"],
      };
    })
    .sort((a, b) => b.size - a.size);
}

// -- win32 implementation -----------------------------------------------------

async function scanWin32(scanPath: string): Promise<Entry[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$items = Get-ChildItem -LiteralPath '${scanPath.replace(/'/g, "''")}'
$out = foreach ($item in $items) {
  if ($item.PSIsContainer) {
    $bytes = (Get-ChildItem -LiteralPath $item.FullName -Recurse -File |
              Measure-Object -Property Length -Sum).Sum
    if ($null -eq $bytes) { $bytes = 0 }
  } else {
    $bytes = $item.Length
  }
  [PSCustomObject]@{
    name      = $item.Name
    path      = $item.FullName
    size      = [long]$bytes
    sizeHuman = if ($bytes -ge 1GB)     { '{0:N1} GB' -f ($bytes / 1GB)   }
                elseif ($bytes -ge 1MB) { '{0:N1} MB' -f ($bytes / 1MB)   }
                elseif ($bytes -ge 1KB) { '{0:N1} KB' -f ($bytes / 1KB)   }
                else                    { "$bytes B" }
    type      = if ($item.PSIsContainer) { 'directory' } else { 'file' }
  }
}
$out | Sort-Object size -Descending | ConvertTo-Json -Depth 2 -Compress
`.trim();

  const raw = await runPS(ps);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Entry | Entry[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

// -- Exported run function ----------------------------------------------------

export async function run({ path: inputPath = os.homedir() }: { path?: string }) {
  const scanPath = nodePath.resolve(inputPath);

  // Security: restrict scanning to within the user home directory.
  // Prevents Claude from being directed to scan /etc, /var, or other
  // system paths that could leak sensitive file names to the LLM context.
  const home = os.homedir();
  const rel  = nodePath.relative(home, scanPath);
  if (rel.startsWith("..") || nodePath.isAbsolute(rel)) {
    throw new Error(
      `[disk_scan] Path must be within home directory (${home}): ${scanPath}`,
    );
  }

  try {
    await fs.access(scanPath);
  } catch {
    throw new Error(`[disk_scan] Path not accessible: ${scanPath}`);
  }

  const platform = os.platform();
  const entries  = platform === "win32"
    ? await scanWin32(scanPath)
    : await scanDarwin(scanPath);

  return {
    scannedPath: scanPath,
    platform,
    entryCount:  entries.length,
    entries,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run({ path: process.argv[2] })
    .then((r) => {
      console.log(`\nScanned: ${r.scannedPath}  (${r.entryCount} entries)\n`);
      r.entries.slice(0, 10).forEach((e) =>
        console.log(
          `  ${e.sizeHuman.padStart(10)}  ${e.type === "directory" ? "[DIR]" : "[FILE]"}  ${e.name}`,
        ),
      );
    })
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
