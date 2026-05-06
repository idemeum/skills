/**
 * mcp/skills/getProcesses.ts — get_processes skill
 *
 * Lists currently running processes with CPU and memory usage, sorted by
 * the specified field.  Helps Claude answer "what is using my CPU/memory?"
 *
 * Platform strategy
 * -----------------
 * darwin  `ps -eo pid,pcpu,rss,comm` — built-in, no extra packages needed
 * win32   PowerShell Get-Process | ConvertTo-Json via -EncodedCommand
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getProcesses.ts [cpu|memory|name] [limit]
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_processes",
  description:
    "Lists currently running processes with CPU percentage and memory usage " +
    "(MB), sorted by the specified field. " +
    "Use when the user reports high CPU or memory usage or wants to identify " +
    "resource-heavy applications.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    sortBy: z
      .enum(["cpu", "memory", "name"])
      .optional()
      .describe("Sort field. Default: cpu (highest first)."),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of processes to return. Default: 30."),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ProcessEntry {
  pid:      number;
  name:     string;
  cpu:      number;   // percentage
  memoryMb: number;   // megabytes (RSS)
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

async function getProcessesDarwin(): Promise<ProcessEntry[]> {
  // ps -eo pid,pcpu,rss,comm
  //   pid   — process ID
  //   pcpu  — CPU % (instantaneous, sampled over last scheduling interval)
  //   rss   — resident set size in KB
  //   comm  — executable name (no args)
  const { stdout } = await execAsync(
    "ps -eo pid,pcpu,rss,comm 2>/dev/null",
    { maxBuffer: 10 * 1024 * 1024 },
  );

  return stdout
    .trim()
    .split("\n")
    .slice(1) // remove header line
    .flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return [];
      const pid      = parseInt(parts[0], 10);
      const cpu      = parseFloat(parts[1]);
      const rssKb    = parseInt(parts[2], 10);
      // comm may contain path separators — keep only the basename
      const fullComm = parts.slice(3).join(" ");
      const name     = fullComm.split("/").at(-1) ?? fullComm;
      if (isNaN(pid)) return [];
      return [{ pid, name, cpu, memoryMb: Math.round((rssKb / 1024) * 10) / 10 }];
    });
}

// -- win32 implementation -----------------------------------------------------

async function getProcessesWin32(): Promise<ProcessEntry[]> {
  // CPU on Windows is cumulative seconds, not a live %. We report it as-is
  // and label it "cpuTimeSeconds" in the name for transparency; the column
  // is still called "cpu" to keep the schema consistent.
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-Process | ForEach-Object {
  [PSCustomObject]@{
    pid      = [int]$_.Id
    name     = $_.ProcessName
    cpu      = [Math]::Round([double]($_.CPU ?? 0), 2)
    memoryMb = [Math]::Round($_.WorkingSet64 / 1MB, 1)
  }
} | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw    = await runPS(ps);
  const parsed = JSON.parse(raw) as ProcessEntry | ProcessEntry[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

// -- Sorting ------------------------------------------------------------------

function sortProcesses(
  list:   ProcessEntry[],
  sortBy: "cpu" | "memory" | "name",
): ProcessEntry[] {
  const copy = [...list];
  if (sortBy === "name")   return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (sortBy === "memory") return copy.sort((a, b) => b.memoryMb - a.memoryMb);
  return copy.sort((a, b) => b.cpu - a.cpu); // "cpu" default
}

// -- Exported run function ----------------------------------------------------

export async function run({
  sortBy = "cpu",
  limit  = 30,
}: {
  sortBy?: "cpu" | "memory" | "name";
  limit?:  number;
} = {}) {
  const platform = os.platform();
  const all      = platform === "win32"
    ? await getProcessesWin32()
    : await getProcessesDarwin();

  const sorted    = sortProcesses(all, sortBy);
  const processes = sorted.slice(0, limit);

  return {
    platform,
    sortBy,
    totalProcesses: all.length,
    returned:       processes.length,
    note: platform === "win32"
      ? "cpu column shows cumulative CPU time in seconds (Windows limitation)"
      : "cpu column shows instantaneous CPU percentage",
    processes,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  const sortBy = (process.argv[2] as "cpu" | "memory" | "name") ?? "cpu";
  const limit  = parseInt(process.argv[3] ?? "10", 10);
  run({ sortBy, limit })
    .then((r) => {
      console.log(`\n${r.totalProcesses} processes — showing top ${r.returned} by ${r.sortBy}\n`);
      r.processes.forEach((p) =>
        console.log(
          `  PID ${String(p.pid).padStart(6)}  CPU ${String(p.cpu).padStart(7)}  ` +
          `MEM ${String(p.memoryMb).padStart(8)} MB  ${p.name}`,
        ),
      );
    })
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
