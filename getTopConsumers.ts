/**
 * mcp/skills/getTopConsumers.ts — get_top_consumers skill
 *
 * Returns processes ranked by combined CPU and memory consumption. Provides a
 * quick snapshot of what is most impacting system performance.
 *
 * Platform strategy
 * -----------------
 * darwin  `ps -eo pid,pcpu,rss,comm` — parse and rank by combined score
 * win32   PowerShell Get-Process | Sort-Object CPU -Descending
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getTopConsumers.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_top_consumers",
  description:
    "Returns processes ranked by combined CPU and memory consumption. Provides " +
    "a quick snapshot of what is most impacting system performance. Use when " +
    "diagnosing slowness without a specific process in mind.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    limit: z
      .number()
      .optional()
      .describe("Number of top processes to return. Default: 10"),
    metric: z
      .enum(["cpu", "memory", "combined"])
      .optional()
      .describe("Ranking metric. Default: combined"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ConsumerEntry {
  pid:           number;
  name:          string;
  cpuPercent:    number;
  memoryMb:      number;
  combinedScore: number;
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

async function getTopConsumersDarwin(
  limit:  number,
  metric: "cpu" | "memory" | "combined",
): Promise<ConsumerEntry[]> {
  const { stdout } = await execAsync(
    "ps -eo pid,pcpu,rss,comm 2>/dev/null",
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const rows = stdout
    .trim()
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) return [];
      const pid      = parseInt(parts[0], 10);
      const cpu      = parseFloat(parts[1]);
      const rssKb    = parseInt(parts[2], 10);
      const fullComm = parts.slice(3).join(" ");
      const name     = fullComm.split("/").at(-1) ?? fullComm;
      if (isNaN(pid)) return [];
      const memoryMb = Math.round((rssKb / 1024) * 10) / 10;
      return [{ pid, name, cpuPercent: cpu, memoryMb, combinedScore: 0 }];
    });

  // Normalise and compute combined score
  const maxCpu = Math.max(...rows.map(r => r.cpuPercent), 1);
  const maxMem = Math.max(...rows.map(r => r.memoryMb), 1);

  for (const r of rows) {
    r.combinedScore = Math.round(
      ((r.cpuPercent / maxCpu) * 50 + (r.memoryMb / maxMem) * 50) * 100,
    ) / 100;
  }

  const sortKey: keyof ConsumerEntry =
    metric === "cpu"    ? "cpuPercent" :
    metric === "memory" ? "memoryMb"   : "combinedScore";

  return rows
    .sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number))
    .slice(0, limit);
}

// -- win32 implementation -----------------------------------------------------

async function getTopConsumersWin32(
  limit:  number,
  metric: "cpu" | "memory" | "combined",
): Promise<ConsumerEntry[]> {
  const sortProp = metric === "memory" ? "WorkingSet64" : "CPU";
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Get-Process | Sort-Object ${sortProp} -Descending | Select-Object -First ${limit} | ForEach-Object {
  [PSCustomObject]@{
    pid        = [int]$_.Id
    name       = $_.ProcessName
    cpuPercent = [Math]::Round([double]($_.CPU ?? 0), 2)
    memoryMb   = [Math]::Round($_.WorkingSet64 / 1MB, 1)
  }
} | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw    = await runPS(ps);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as Omit<ConsumerEntry, "combinedScore">[] | Omit<ConsumerEntry, "combinedScore">;
  const arr    = Array.isArray(parsed) ? parsed : [parsed];

  const maxCpu = Math.max(...arr.map(r => r.cpuPercent), 1);
  const maxMem = Math.max(...arr.map(r => r.memoryMb), 1);

  return arr.map(r => ({
    ...r,
    combinedScore: Math.round(
      ((r.cpuPercent / maxCpu) * 50 + (r.memoryMb / maxMem) * 50) * 100,
    ) / 100,
  }));
}

// -- Exported run function ----------------------------------------------------

export async function run({
  limit  = 10,
  metric = "combined",
}: {
  limit?:  number;
  metric?: "cpu" | "memory" | "combined";
} = {}) {
  const platform  = os.platform();
  const processes = platform === "win32"
    ? await getTopConsumersWin32(limit, metric)
    : await getTopConsumersDarwin(limit, metric);

  return {
    platform,
    metric,
    processes,
    sampledAt: new Date().toISOString(),
  };
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
