/**
 * mcp/skills/getDockerDiskUsage.ts — get_docker_disk_usage skill
 *
 * Reports Docker disk-usage breakdown via `docker system df` without
 * pruning anything.  Read-only counterpart to `prune_docker`.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/getDockerDiskUsage.ts
 *
 * NOTE: parsing logic is duplicated from `pruneDocker.ts` getDockerDf —
 * keep in sync if docker system df output format changes.
 */

import * as os from "os";

import { execAsync } from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "get_docker_disk_usage",
  description:
    "Reports Docker disk usage (reclaimable space, container/image/volume counts) " +
    "via `docker system df` without modifying anything. Read-only counterpart to " +
    "prune_docker. Returns dockerInstalled:false when Docker is not available.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   [],
  schema:          {},
} as const;

// -- Types --------------------------------------------------------------------

export interface DockerBreakdownEntry {
  type:             string;
  totalCount:       number;
  activeCount:      number;
  size:             string;
  reclaimable:      string;
  reclaimableBytes: number;
}

export interface GetDockerDiskUsageResult {
  platform:               NodeJS.Platform;
  dockerInstalled:        boolean;
  dockerRunning:          boolean;
  totalReclaimableBytes:  number;
  breakdown:              DockerBreakdownEntry[];
  errors?:                Array<{ scope: string; message: string }>;
}

// -- Helpers ------------------------------------------------------------------

function parseSizeToBytes(s: string): number {
  const m = s.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  const val  = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "TB") return Math.round(val * 1024 * 1024 * 1024 * 1024);
  if (unit === "GB") return Math.round(val * 1024 * 1024 * 1024);
  if (unit === "MB") return Math.round(val * 1024 * 1024);
  if (unit === "KB") return Math.round(val * 1024);
  return Math.round(val);
}

async function checkDockerInstalled(): Promise<boolean> {
  try {
    await execAsync("docker --version", { maxBuffer: 1 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function checkDockerRunning(): Promise<boolean> {
  try {
    await execAsync("docker info 2>/dev/null", { maxBuffer: 2 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

// -- Exported run -------------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<GetDockerDiskUsageResult> {
  const platform = os.platform();

  const dockerInstalled = await checkDockerInstalled();
  if (!dockerInstalled) {
    return {
      platform,
      dockerInstalled: false,
      dockerRunning:   false,
      totalReclaimableBytes: 0,
      breakdown: [],
    };
  }

  const dockerRunning = await checkDockerRunning();
  if (!dockerRunning) {
    return {
      platform,
      dockerInstalled: true,
      dockerRunning:   false,
      totalReclaimableBytes: 0,
      breakdown: [],
      errors: [{ scope: "docker-daemon", message: "Docker is installed but the daemon is not running." }],
    };
  }

  // Use the columnar `docker system df` (not --format) so we get TOTAL/ACTIVE
  // counts in addition to size + reclaimable.  Output looks like:
  //   TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
  //   Images          12        3         2.5GB     1.8GB (72%)
  //   Containers      5         2         100MB     50MB (50%)
  //   Local Volumes   3         1         500MB     200MB (40%)
  //   Build Cache     0         0         0B        0B
  let stdout = "";
  try {
    ({ stdout } = await execAsync("docker system df", { maxBuffer: 4 * 1024 * 1024 }));
  } catch (err) {
    return {
      platform,
      dockerInstalled: true,
      dockerRunning:   true,
      totalReclaimableBytes: 0,
      breakdown: [],
      errors: [{ scope: "docker-system-df", message: (err as Error).message }],
    };
  }

  const breakdown: DockerBreakdownEntry[] = [];
  let totalReclaimableBytes = 0;
  const lines = stdout.trim().split("\n");

  // Skip the header line; iterate data rows.
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].trim();
    if (!row) continue;
    // Tokenise on 2+ spaces to keep multi-word types ("Local Volumes",
    // "Build Cache") intact.
    const parts = row.split(/\s{2,}/);
    if (parts.length < 5) continue;
    const [type, totalStr, activeStr, sizeStr, reclaimableStr] = parts;
    const reclaimableBytes = parseSizeToBytes(reclaimableStr);
    totalReclaimableBytes += reclaimableBytes;
    breakdown.push({
      type,
      totalCount:       parseInt(totalStr, 10)  || 0,
      activeCount:      parseInt(activeStr, 10) || 0,
      size:             sizeStr,
      reclaimable:      reclaimableStr,
      reclaimableBytes,
    });
  }

  return {
    platform,
    dockerInstalled: true,
    dockerRunning:   true,
    totalReclaimableBytes,
    breakdown,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (require.main === module) {
  run()
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
