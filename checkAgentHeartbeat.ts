/**
 * mcp/skills/checkAgentHeartbeat.ts — check_agent_heartbeat skill
 *
 * Reports the heartbeat state of the locally-installed endpoint
 * security agent (CrowdStrike, SentinelOne, Jamf Protect, Microsoft
 * Defender, Carbon Black, Cylance) as a flat top-level object suitable
 * for the proactive evaluator's restricted DSL.  Combines two existing
 * signals into one telemetry-shaped result:
 *
 *   1. process / service running state — matches `check_agent_process`'s
 *      detection logic but inlined here so the tool is self-contained
 *      under tsconfig.skills.json (rootDir: mcp/skills).
 *   2. recent activity — mtime of the agent's per-vendor log directory
 *      as a proxy for "last heartbeat".  Vendor SDKs would expose a
 *      proper liveness ping, but log-dir mtime is a robust available-
 *      everywhere fallback.
 *
 * Wave 2 Track B Phase 4 attaches Trigger 3 (`agent-not-heartbeating`) to
 * the security-agent-repair skill with the condition:
 *   "healthy == false && ageSec >= 900"
 *
 * Read-only.  Always returns a result — even when no agent is detected
 * the tool returns a `healthy: false` shape so the rule can fire.
 */

import * as os   from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { z }     from "zod";

import {
  execAsync,
  runPS,
  isDarwin,
  isWin32,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_agent_heartbeat",
  description:
    "Reports a top-level liveness summary for the installed endpoint " +
    "security agent — vendor name, last activity timestamp (log-dir " +
    "mtime), age in seconds, status, and a boolean `healthy`. Used both " +
    "by the security-agent-repair skill as a quick health probe and as " +
    "the telemetry source for the proactive agent-not-heartbeating " +
    "trigger. Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  tccCategories:   ["FullDiskAccess"],
  // See docs/proactivesupport/PROACTIVE-ARCHITECTURE.md §6.
  outputKeys: [
    "platform",
    "vendor",
    "lastHeartbeatMs",
    "ageSec",
    "status",
    "healthy",
  ],
  schema: {
    healthyAgeSec: z
      .number()
      .int()
      .min(60)
      .max(86_400)
      .optional()
      .describe(
        "Maximum age (seconds) before the agent is considered " +
        "not-heartbeating. Default 900 (15 min) matches the Wave 2 Trigger 3 " +
        "duration window.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

export type AgentVendor =
  | "crowdstrike"
  | "sentinelone"
  | "jamf"
  | "defender"
  | "carbonblack"
  | "cylance";

export type HeartbeatStatus =
  | "healthy"
  | "stale"            // process running but log-mtime old
  | "process-stopped"  // process not running
  | "not-installed"
  | "unknown";

export interface CheckAgentHeartbeatResult {
  platform:        NodeJS.Platform;
  /** Detected vendor.  null when no known agent is installed. */
  vendor:          AgentVendor | null;
  /** ms since epoch — null when no log path was readable. */
  lastHeartbeatMs: number | null;
  /** Seconds since lastHeartbeatMs.  When null lastHeartbeatMs, returns a large sentinel so DSL conditions on `ageSec >= N` evaluate true. */
  ageSec:          number;
  /** Process / service running flag. */
  isRunning:       boolean;
  status:          HeartbeatStatus;
  healthy:         boolean;
}

// -- Vendor probe registry ----------------------------------------------------

interface VendorProbe {
  vendor:        AgentVendor;
  darwinNames:   string[];        // pgrep -x candidates
  win32Service:  string | null;
  darwinLogDirs: string[];        // mtime probe candidates
  win32LogDirs:  string[];
}

const VENDORS: VendorProbe[] = [
  {
    vendor:        "crowdstrike",
    darwinNames:   ["com.crowdstrike.falcon.Agent", "falcond"],
    win32Service:  "CSFalconService",
    darwinLogDirs: ["/Library/Logs/Crowdstrike", "/Library/Logs/CrowdStrike"],
    win32LogDirs:  [
      "C:\\Windows\\System32\\drivers\\CrowdStrike",
      "C:\\ProgramData\\CrowdStrike\\Logs",
    ],
  },
  {
    vendor:        "sentinelone",
    darwinNames:   ["SentinelAgent", "sentineld"],
    win32Service:  "SentinelAgent",
    darwinLogDirs: ["/Library/Logs/SentinelOne"],
    win32LogDirs:  ["C:\\ProgramData\\Sentinel\\Logs"],
  },
  {
    vendor:        "jamf",
    darwinNames:   ["JamfAgent", "jamf"],
    win32Service:  null,   // macOS-only
    darwinLogDirs: ["/Library/Logs/jamfprotect", "/var/log/jamf.log"],
    win32LogDirs:  [],
  },
  {
    vendor:        "defender",
    darwinNames:   ["wdavdaemon", "mdatp", "Microsoft Defender"],
    win32Service:  "WinDefend",
    darwinLogDirs: ["/Library/Logs/Microsoft/mdatp"],
    win32LogDirs:  ["C:\\ProgramData\\Microsoft\\Windows Defender\\Support"],
  },
  {
    vendor:        "carbonblack",
    darwinNames:   ["cbagentd", "CbOsxSensorService"],
    win32Service:  "CbDefense",
    darwinLogDirs: ["/Library/Logs/CbDefense"],
    win32LogDirs:  ["C:\\ProgramData\\CarbonBlack\\Logs"],
  },
  {
    vendor:        "cylance",
    darwinNames:   ["CylanceUI", "cylance"],
    win32Service:  "CylanceSvc",
    darwinLogDirs: ["/Library/Application Support/Cylance/Desktop/log"],
    win32LogDirs:  ["C:\\Program Files\\Cylance\\Desktop\\log"],
  },
];

// -- Filesystem + process helpers ---------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function newestMtimeMs(paths: string[]): Promise<number | null> {
  let newest: number | null = null;
  for (const p of paths) {
    try {
      const s = await fs.stat(p);
      if (s.isDirectory()) {
        // Walk one level deep and take the newest entry mtime.
        try {
          const entries = await fs.readdir(p, { withFileTypes: true });
          for (const e of entries) {
            try {
              const inner = await fs.stat(path.join(p, e.name));
              if (newest === null || inner.mtimeMs > newest) newest = inner.mtimeMs;
            } catch {
              // ignore unreadable entry
            }
          }
        } catch {
          // ignore unreadable dir
        }
        // Also consider the dir's own mtime.
        if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
      } else {
        if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
      }
    } catch {
      // missing path — skip
    }
  }
  return newest;
}

async function isProcessRunningDarwin(names: string[]): Promise<boolean> {
  for (const n of names) {
    try {
      // pgrep -x exits 0 when at least one process matches.
      // shell-quote the name to handle spaces (Microsoft Defender etc.).
      await execAsync(`pgrep -x ${JSON.stringify(n)}`, { timeout: 5_000 });
      return true;
    } catch {
      // pgrep exits non-zero when no match — try the next candidate.
    }
  }
  return false;
}

async function isServiceRunningWin32(serviceName: string): Promise<boolean> {
  try {
    const stdout = await runPS(
      `(Get-Service -Name ${JSON.stringify(serviceName)} -ErrorAction SilentlyContinue).Status`,
      { timeoutMs: 5_000 },
    );
    return stdout.trim().toLowerCase() === "running";
  } catch {
    return false;
  }
}

// -- Per-vendor probe ---------------------------------------------------------

async function probeVendor(
  v:        VendorProbe,
  platform: NodeJS.Platform,
): Promise<{ vendor: AgentVendor; isRunning: boolean; lastHeartbeatMs: number | null }> {
  const isRunning = platform === "darwin"
    ? await isProcessRunningDarwin(v.darwinNames)
    : v.win32Service ? await isServiceRunningWin32(v.win32Service) : false;

  const logDirs = platform === "darwin" ? v.darwinLogDirs : v.win32LogDirs;
  const lastHeartbeatMs = await newestMtimeMs(logDirs);

  return { vendor: v.vendor, isRunning, lastHeartbeatMs };
}

// -- Status computation -------------------------------------------------------

const SENTINEL_AGE_SEC = 24 * 60 * 60 * 365 * 10;   // 10 years — "no heartbeat ever".

interface ComputeInputs {
  isRunning:        boolean;
  lastHeartbeatMs:  number | null;
  vendor:           AgentVendor | null;
  healthyAgeSec:    number;
}

function computeStatus(i: ComputeInputs): { ageSec: number; status: HeartbeatStatus; healthy: boolean } {
  if (i.vendor === null) {
    return { ageSec: SENTINEL_AGE_SEC, status: "not-installed", healthy: false };
  }
  if (!i.isRunning) {
    const age = i.lastHeartbeatMs === null
      ? SENTINEL_AGE_SEC
      : Math.round((Date.now() - i.lastHeartbeatMs) / 1000);
    return { ageSec: age, status: "process-stopped", healthy: false };
  }
  // Process IS running.
  if (i.lastHeartbeatMs === null) {
    // No log path readable — surface as unknown rather than guessing healthy.
    return { ageSec: SENTINEL_AGE_SEC, status: "unknown", healthy: false };
  }
  const ageSec = Math.round((Date.now() - i.lastHeartbeatMs) / 1000);
  if (ageSec <= i.healthyAgeSec) {
    return { ageSec, status: "healthy", healthy: true };
  }
  return { ageSec, status: "stale", healthy: false };
}

// -- Top-level vendor picker --------------------------------------------------

interface VendorState {
  vendor:          AgentVendor;
  isRunning:       boolean;
  lastHeartbeatMs: number | null;
}

function pickVendor(states: VendorState[]): VendorState | null {
  const installed = states.filter((s) => s.isRunning || s.lastHeartbeatMs !== null);
  if (installed.length === 0) return null;

  // Prefer the freshest heartbeat among running agents — that's the
  // user's "real" agent.  If none running but logs present, return the
  // freshest log (a recently-stopped agent).
  const running = installed.filter((s) => s.isRunning);
  if (running.length > 0) {
    return running.reduce((best, s) =>
      (s.lastHeartbeatMs ?? 0) > (best.lastHeartbeatMs ?? 0) ? s : best);
  }
  return installed.reduce((best, s) =>
    (s.lastHeartbeatMs ?? 0) > (best.lastHeartbeatMs ?? 0) ? s : best);
}

// -- Exported run function ----------------------------------------------------

const DEFAULT_HEALTHY_AGE_SEC = 900;   // 15 min — matches Trigger 3 duration.

export async function run({
  healthyAgeSec = DEFAULT_HEALTHY_AGE_SEC,
}: { healthyAgeSec?: number } = {}): Promise<CheckAgentHeartbeatResult> {
  const platform = os.platform();
  if (!isDarwin() && !isWin32()) {
    throw new Error(`check_agent_heartbeat: unsupported platform "${platform}"`);
  }

  const states = await Promise.all(VENDORS.map((v) => probeVendor(v, platform)));
  const top    = pickVendor(states);

  const { ageSec, status, healthy } = computeStatus({
    isRunning:        top?.isRunning      ?? false,
    lastHeartbeatMs:  top?.lastHeartbeatMs ?? null,
    vendor:           top?.vendor          ?? null,
    healthyAgeSec,
  });

  return {
    platform,
    vendor:          top?.vendor          ?? null,
    lastHeartbeatMs: top?.lastHeartbeatMs ?? null,
    ageSec,
    isRunning:       top?.isRunning      ?? false,
    status,
    healthy,
  };
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  VENDORS,
  pathExists,
  newestMtimeMs,
  isProcessRunningDarwin,
  isServiceRunningWin32,
  probeVendor,
  pickVendor,
  computeStatus,
  SENTINEL_AGE_SEC,
};
