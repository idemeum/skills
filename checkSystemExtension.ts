/**
 * mcp/skills/checkSystemExtension.ts — check_system_extension skill
 *
 * Verifies that security agent system extensions are loaded and user-approved.
 * Security agents require system extensions to function at the kernel level.
 * Unapproved extensions appear installed but are non-functional.
 * macOS only for system extensions; Windows checks driver/service status.
 *
 * Platform strategy
 * -----------------
 * darwin  `systemextensionsctl list` — parse tabular output
 * win32   PowerShell Get-MpComputerStatus and Get-Service
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkSystemExtension.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_system_extension",
  description:
    "Verifies that security agent system extensions are loaded and user-approved. " +
    "Security agents require system extensions to function at the kernel level. " +
    "Unapproved extensions appear installed but are non-functional. " +
    "macOS only for system extensions; Windows checks driver/service status.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    bundleId: z
      .string()
      .optional()
      .describe(
        "Extension bundle ID to check (e.g. 'com.crowdstrike.falcon.Agent'). " +
        "Omit to list all security-related extensions",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface ExtensionEntry {
  teamId:           string;
  bundleId:         string;
  version:          string;
  state:            string;
  isActive:         boolean;
  requiresApproval: boolean;
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

async function checkSystemExtensionDarwin(
  bundleId?: string,
): Promise<{ platform: string; extensions: ExtensionEntry[]; allActive: boolean }> {
  let stdout = "";
  try {
    ({ stdout } = await execAsync("systemextensionsctl list 2>/dev/null", {
      maxBuffer: 2 * 1024 * 1024,
    }));
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? "";
  }

  const lines      = stdout.trim().split("\n");
  const extensions: ExtensionEntry[] = [];

  // Each data line looks like:
  //   <teamId>  *  <bundleId> (version)  [state]
  // e.g.:
  //   X9E956P446  *  com.crowdstrike.falcon.Agent (21.10.8813.0) [activated enabled]
  const lineRe = /^(\S+)\s+[\*\s]\s+(\S+)\s+\(([^)]+)\)\s+\[([^\]]+)\]/;

  for (const line of lines) {
    const m = line.trim().match(lineRe);
    if (!m) continue;
    const [, teamId, bid, version, state] = m;
    if (bundleId && bid !== bundleId) continue;

    // Filter to security-related extensions when no bundleId specified
    const securityKeywords = [
      "crowdstrike", "sentinelone", "jamf", "carbonblack", "cylance",
      "defender", "microsoft", "security", "endpoint", "falcon", "sentinel",
    ];
    if (!bundleId) {
      const lower = bid.toLowerCase();
      if (!securityKeywords.some((kw) => lower.includes(kw))) continue;
    }

    const isActive         = state.includes("activated") && state.includes("enabled");
    const requiresApproval = state.includes("waiting for user");
    extensions.push({ teamId, bundleId: bid, version, state, isActive, requiresApproval });
  }

  return {
    platform:  "darwin",
    extensions,
    allActive: extensions.length > 0 && extensions.every((e) => e.isActive),
  };
}

// -- win32 implementation -----------------------------------------------------

async function checkSystemExtensionWin32(
  _bundleId?: string,
): Promise<{ platform: string; extensions: ExtensionEntry[]; allActive: boolean }> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$mpStatus = Get-MpComputerStatus | Select-Object AMRunningMode,AntispywareEnabled,RealTimeProtectionEnabled,NISEnabled
$secSvcs  = Get-Service | Where-Object { $_.DisplayName -match 'security|endpoint|falcon|sentinel|defender|crowdstrike' } |
            Select-Object Name,DisplayName,Status
[PSCustomObject]@{
  mpStatus = $mpStatus
  services = @($secSvcs)
} | ConvertTo-Json -Depth 3 -Compress`.trim();

  const raw  = await runPS(ps);
  const extensions: ExtensionEntry[] = [];

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        mpStatus?: { AMRunningMode?: string; AntispywareEnabled?: boolean; RealTimeProtectionEnabled?: boolean };
        services?: Array<{ Name: string; DisplayName: string; Status: string }>;
      };

      if (parsed.mpStatus) {
        const mp    = parsed.mpStatus;
        const state = mp.RealTimeProtectionEnabled ? "active" : "inactive";
        extensions.push({
          teamId:           "Microsoft",
          bundleId:         "com.microsoft.defender",
          version:          mp.AMRunningMode ?? "unknown",
          state,
          isActive:         !!mp.RealTimeProtectionEnabled,
          requiresApproval: false,
        });
      }

      for (const svc of parsed.services ?? []) {
        const isActive = svc.Status === "Running";
        extensions.push({
          teamId:           "service",
          bundleId:         svc.Name,
          version:          svc.DisplayName,
          state:            svc.Status,
          isActive,
          requiresApproval: false,
        });
      }
    } catch {
      // JSON parse failure — return empty
    }
  }

  return {
    platform:  "win32",
    extensions,
    allActive: extensions.length > 0 && extensions.every((e) => e.isActive),
  };
}

// -- Exported run function ----------------------------------------------------

export async function run({
  bundleId,
}: {
  bundleId?: string;
} = {}) {
  const platform = os.platform();
  return platform === "win32"
    ? checkSystemExtensionWin32(bundleId)
    : checkSystemExtensionDarwin(bundleId);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
