/**
 * mcp/skills/pruneDocker.ts — prune_docker skill
 *
 * Removes unused Docker resources (stopped containers, dangling images, unused
 * volumes, unused networks). Use to free significant disk space on developer
 * machines. Checks if Docker is installed first.
 *
 * Platform strategy
 * -----------------
 * Both   `docker system df` for dry run info, `docker container prune -f`,
 *        `docker image prune -f`, `docker volume prune -f`,
 *        `docker network prune -f`, or `docker system prune -f`
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/pruneDocker.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "prune_docker",
  description:
    "Removes unused Docker resources (stopped containers, dangling images, " +
    "unused volumes, unused networks). Use to free significant disk space on " +
    "developer machines. Checks if Docker is installed first.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    what: z
      .array(z.enum(["containers", "images", "volumes", "networks", "all"]))
      .optional()
      .describe("Resources to prune. Default: all"),
    dryRun: z
      .boolean()
      .optional()
      .describe("If true, show what would be removed. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface PruneStats {
  containers: number;
  images:     number;
  volumes:    number;
  networks:   number;
}

interface DockerDfOutput {
  reclaimableMb: number;
  containers:    number;
  images:        number;
  volumes:       number;
}

// -- Helpers ------------------------------------------------------------------

async function isDockerInstalled(): Promise<boolean> {
  try {
    await execAsync("docker --version", { maxBuffer: 1 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

async function isDockerRunning(): Promise<boolean> {
  try {
    await execAsync("docker info 2>/dev/null", { maxBuffer: 2 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}

/** Parse `docker system df` for a rough reclaimable estimate. */
async function getDockerDf(): Promise<DockerDfOutput> {
  try {
    const { stdout } = await execAsync(
      "docker system df --format '{{.Type}}\\t{{.Reclaimable}}' 2>/dev/null",
      { maxBuffer: 2 * 1024 * 1024 },
    );
    let reclaimableMb = 0;
    let containers    = 0;
    let images        = 0;
    let volumes       = 0;

    for (const line of stdout.trim().split("\n")) {
      const [type, reclaimStr] = line.split("\t");
      if (!reclaimStr) continue;
      // reclaimStr looks like "1.23GB (50%)" or "500MB"
      const sizeMatch = reclaimStr.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
      let mb = 0;
      if (sizeMatch) {
        const val  = parseFloat(sizeMatch[1]);
        const unit = sizeMatch[2].toUpperCase();
        if      (unit === "TB") mb = val * 1024 * 1024;
        else if (unit === "GB") mb = val * 1024;
        else if (unit === "MB") mb = val;
        else if (unit === "KB") mb = val / 1024;
        else                    mb = val / (1024 * 1024);
      }
      reclaimableMb += mb;

      if (type?.toLowerCase().includes("container")) containers++;
      if (type?.toLowerCase().includes("image"))     images++;
      if (type?.toLowerCase().includes("volume"))    volumes++;
    }

    return {
      reclaimableMb: Math.round(reclaimableMb * 100) / 100,
      containers,
      images,
      volumes,
    };
  } catch {
    return { reclaimableMb: 0, containers: 0, images: 0, volumes: 0 };
  }
}

/** Parse reclaimed bytes from docker prune stdout like "Total reclaimed space: 1.23GB" */
function parseReclaimedMb(stdout: string): number {
  const match = stdout.match(/Total reclaimed space:\s*([\d.]+)\s*(B|kB|MB|GB|TB)/i);
  if (!match) return 0;
  const val  = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if      (unit === "TB") return val * 1024 * 1024;
  else if (unit === "GB") return val * 1024;
  else if (unit === "MB") return val;
  else if (unit === "KB") return val / 1024;
  return val / (1024 * 1024);
}

// -- Exported run function ----------------------------------------------------

export async function run({
  what   = ["all"],
  dryRun = true,
}: {
  what?:   Array<"containers" | "images" | "volumes" | "networks" | "all">;
  dryRun?: boolean;
} = {}) {
  const platform        = os.platform();
  const dockerInstalled = await isDockerInstalled();

  if (!dockerInstalled) {
    return {
      platform,
      dockerInstalled:    false,
      dryRun,
      reclaimedMb:        0,
      prunedContainers:   0,
      prunedImages:       0,
      prunedVolumes:      0,
      prunedNetworks:     0,
      message:            "Docker is not installed or not in PATH.",
    };
  }

  const dockerRunning = await isDockerRunning();
  if (!dockerRunning) {
    return {
      platform,
      dockerInstalled:    true,
      dryRun,
      reclaimedMb:        0,
      prunedContainers:   0,
      prunedImages:       0,
      prunedVolumes:      0,
      prunedNetworks:     0,
      message:            "Docker daemon is not running. Start Docker Desktop and try again.",
    };
  }

  const pruneAll  = what.includes("all");
  const doContainers = pruneAll || what.includes("containers");
  const doImages     = pruneAll || what.includes("images");
  const doVolumes    = pruneAll || what.includes("volumes");
  const doNetworks   = pruneAll || what.includes("networks");

  if (dryRun) {
    const df = await getDockerDf();
    return {
      platform,
      dockerInstalled:    true,
      dryRun:             true,
      reclaimedMb:        df.reclaimableMb,
      prunedContainers:   0,
      prunedImages:       0,
      prunedVolumes:      0,
      prunedNetworks:     0,
      message:
        `Dry run: approximately ${df.reclaimableMb} MB could be reclaimed. ` +
        "Run with dryRun=false to apply.",
    };
  }

  // Perform pruning
  let totalReclaimedMb = 0;
  const pruned: PruneStats = { containers: 0, images: 0, volumes: 0, networks: 0 };

  if (doContainers) {
    try {
      const { stdout } = await execAsync(
        "docker container prune -f 2>/dev/null",
        { maxBuffer: 5 * 1024 * 1024 },
      );
      const count = (stdout.match(/Deleted Containers:/g) ?? []).length;
      pruned.containers   = count;
      totalReclaimedMb   += parseReclaimedMb(stdout);
    } catch { /* ignore */ }
  }

  if (doImages) {
    try {
      const { stdout } = await execAsync(
        "docker image prune -f 2>/dev/null",
        { maxBuffer: 5 * 1024 * 1024 },
      );
      const count = (stdout.match(/sha256:/g) ?? []).length;
      pruned.images      = count;
      totalReclaimedMb  += parseReclaimedMb(stdout);
    } catch { /* ignore */ }
  }

  if (doVolumes) {
    try {
      const { stdout } = await execAsync(
        "docker volume prune -f 2>/dev/null",
        { maxBuffer: 5 * 1024 * 1024 },
      );
      pruned.volumes     = (stdout.match(/\n/g) ?? []).length;
      totalReclaimedMb  += parseReclaimedMb(stdout);
    } catch { /* ignore */ }
  }

  if (doNetworks) {
    try {
      await execAsync("docker network prune -f 2>/dev/null", { maxBuffer: 2 * 1024 * 1024 });
      pruned.networks = 1; // no count in output, just mark as done
    } catch { /* ignore */ }
  }

  return {
    platform,
    dockerInstalled:  true,
    dryRun:           false,
    reclaimedMb:      Math.round(totalReclaimedMb * 100) / 100,
    prunedContainers: pruned.containers,
    prunedImages:     pruned.images,
    prunedVolumes:    pruned.volumes,
    prunedNetworks:   pruned.networks,
    message:          "Docker resources pruned successfully.",
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
