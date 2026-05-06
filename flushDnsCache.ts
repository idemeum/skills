/**
 * mcp/skills/flushDnsCache.ts — flush_dns_cache skill
 *
 * Clears the operating system DNS resolver cache. Useful after VPN
 * connect/disconnect, network configuration changes, or when DNS resolution
 * is returning stale or incorrect results.
 *
 * Platform strategy
 * -----------------
 * darwin  `sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`
 * win32   PowerShell Clear-DnsClientCache
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/flushDnsCache.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "flush_dns_cache",
  description:
    "Clears the operating system DNS resolver cache. " +
    "Use after VPN connect/disconnect, network configuration changes, or when " +
    "DNS resolution is returning stale/incorrect results.",
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder",
    win32:  "Clear-DnsClientCache  # run from elevated PowerShell",
  },
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

interface FlushResult {
  success:  boolean;
  platform: string;
  command:  string;
  error?:   string;
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 5 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function flushDnsDarwin(): Promise<FlushResult> {
  const command = "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder";
  try {
    await execAsync(command, { shell: "/bin/bash" });
    return { success: true, platform: "darwin", command };
  } catch (err) {
    return {
      success:  false,
      platform: "darwin",
      command,
      error:    (err as Error).message,
    };
  }
}

// -- win32 implementation -----------------------------------------------------

async function flushDnsWin32(): Promise<FlushResult> {
  const command = "Clear-DnsClientCache";
  try {
    await runPS(command);
    return { success: true, platform: "win32", command };
  } catch (err) {
    return {
      success:  false,
      platform: "win32",
      command,
      error:    (err as Error).message,
    };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {} as Record<string, never>) {
  const platform = os.platform();
  return platform === "win32"
    ? flushDnsWin32()
    : flushDnsDarwin();
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
