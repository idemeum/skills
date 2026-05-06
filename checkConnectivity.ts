/**
 * mcp/skills/checkConnectivity.ts — check_connectivity skill
 *
 * Checks network connectivity by pinging multiple targets (gateway, DNS
 * servers, and internet hosts). Returns reachability status for each target.
 *
 * Platform strategy
 * -----------------
 * darwin  `ping -c {count} -W 2 {target}` — built-in BSD ping
 * win32   PowerShell Test-Connection | ConvertTo-Json
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkConnectivity.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_connectivity",
  description:
    "Checks network connectivity by pinging multiple targets (gateway, DNS " +
    "servers, and internet hosts). Returns reachability status for each target. " +
    "Use when user reports network issues, before/after VPN operations, or when " +
    "diagnosing email/service connectivity problems.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    targets: z
      .array(z.string())
      .optional()
      .describe("Hosts to ping. Defaults to ['8.8.8.8', '1.1.1.1', 'google.com']"),
    count: z
      .number()
      .optional()
      .describe("Ping count per target. Default: 3"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface TargetResult {
  host:         string;
  reachable:    boolean;
  packetLoss:   number;
  avgRttMs:     number | null;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 20 * 1024 * 1024, timeout: 20_000 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function pingTargetDarwin(host: string, count: number): Promise<TargetResult> {
  // Validate host to prevent shell injection — allow hostnames, IPv4, IPv6
  if (!/^[a-zA-Z0-9.\-:]+$/.test(host)) {
    return { host, reachable: false, packetLoss: 100, avgRttMs: null };
  }
  try {
    const { stdout } = await execAsync(
      `ping -c ${count} -W 2 ${host} 2>&1`,
      { maxBuffer: 1 * 1024 * 1024, timeout: 15_000 },
    );

    // Parse packet loss: "3 packets transmitted, 3 packets received, 0.0% packet loss"
    const lossMatch = stdout.match(/(\d+(?:\.\d+)?)%\s+packet loss/);
    const packetLoss = lossMatch ? parseFloat(lossMatch[1]) : 100;

    // Parse RTT: "round-trip min/avg/max/stddev = 1.234/5.678/9.012/0.123 ms"
    const rttMatch = stdout.match(/min\/avg\/max\/(?:stddev|mdev)\s*=\s*[\d.]+\/([\d.]+)/);
    const avgRttMs = rttMatch ? parseFloat(rttMatch[1]) : null;

    return {
      host,
      reachable:  packetLoss < 100,
      packetLoss,
      avgRttMs,
    };
  } catch (err) {
    // ping exits non-zero when host is unreachable; stdout may still have loss info
    const stdout = (err as { stdout?: string }).stdout ?? "";
    const lossMatch = stdout.match(/(\d+(?:\.\d+)?)%\s+packet loss/);
    const packetLoss = lossMatch ? parseFloat(lossMatch[1]) : 100;
    return { host, reachable: false, packetLoss, avgRttMs: null };
  }
}

async function checkConnectivityDarwin(
  targets: string[],
  count: number,
): Promise<TargetResult[]> {
  return Promise.all(targets.map((t) => pingTargetDarwin(t, count)));
}

// -- win32 implementation -----------------------------------------------------

async function checkConnectivityWin32(
  targets: string[],
  count: number,
): Promise<TargetResult[]> {
  const safeTargets = targets.filter((t) => /^[a-zA-Z0-9.\-:]+$/.test(t));
  const targetList  = safeTargets.map((t) => `'${t}'`).join(",");

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$results = @()
foreach ($host in @(${targetList})) {
  $pings = Test-Connection -ComputerName $host -Count ${count} -ErrorAction SilentlyContinue
  if ($null -eq $pings -or $pings.Count -eq 0) {
    $results += [PSCustomObject]@{
      host       = $host
      reachable  = $false
      packetLoss = 100
      avgRttMs   = $null
    }
  } else {
    $received   = ($pings | Where-Object { $_.StatusCode -eq 0 }).Count
    $loss       = [Math]::Round((1 - ($received / ${count})) * 100, 1)
    $avgRtt     = if ($received -gt 0) { [Math]::Round(($pings | Where-Object { $_.StatusCode -eq 0 } | Measure-Object ResponseTime -Average).Average, 2) } else { $null }
    $results += [PSCustomObject]@{
      host       = $host
      reachable  = ($received -gt 0)
      packetLoss = $loss
      avgRttMs   = $avgRtt
    }
  }
}
$results | ConvertTo-Json -Depth 2 -Compress`.trim();

  const raw    = await runPS(ps);
  const parsed = JSON.parse(raw) as TargetResult | TargetResult[];
  const arr    = Array.isArray(parsed) ? parsed : [parsed];

  // Re-add any filtered-out invalid hosts as unreachable
  return targets.map((host) => {
    const found = arr.find((r) => r.host === host);
    return found ?? { host, reachable: false, packetLoss: 100, avgRttMs: null };
  });
}

// -- Exported run function ----------------------------------------------------

export async function run({
  targets = ["8.8.8.8", "1.1.1.1", "google.com"],
  count   = 3,
}: {
  targets?: string[];
  count?:   number;
} = {}) {
  const platform = os.platform();
  const results  = platform === "win32"
    ? await checkConnectivityWin32(targets, count)
    : await checkConnectivityDarwin(targets, count);

  return {
    platform,
    targets:      results,
    allReachable: results.every((r) => r.reachable),
    anyReachable: results.some((r) => r.reachable),
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
