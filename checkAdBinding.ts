/**
 * mcp/skills/checkAdBinding.ts — check_ad_binding skill
 *
 * Checks whether the Mac is bound to an Active Directory domain and reports
 * the binding status, domain name, and last successful authentication. Use
 * when diagnosing AD login failures or password sync issues.
 *
 * Platform strategy
 * -----------------
 * darwin  `dsconfigad -show` to get AD config,
 *         `dscl /Active\ Directory/ -list /` for domain list
 * win32   PowerShell (Get-WmiObject Win32_ComputerSystem).PartOfDomain and
 *         [System.DirectoryServices.ActiveDirectory.Domain]::GetCurrentDomain()
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/checkAdBinding.ts
 */

import * as os       from "os";
import { exec }      from "child_process";
import { promisify } from "util";
import { z }         from "zod";

const execAsync = promisify(exec);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "check_ad_binding",
  description:
    "Checks whether the Mac is bound to an Active Directory domain and reports " +
    "the binding status, domain name, and last successful authentication. " +
    "Use when diagnosing AD login failures or password sync issues.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

interface AdBindingInfo {
  isBound:          boolean;
  domain:           string | null;
  domainController: string | null;
  lastBindCheck:    string | null;
  errors:           string[];
}

// -- PowerShell helper --------------------------------------------------------

async function runPS(script: string): Promise<string> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout.trim();
}

// -- darwin implementation ----------------------------------------------------

async function checkAdBindingDarwin(): Promise<AdBindingInfo> {
  const errors: string[] = [];
  let isBound           = false;
  let domain:           string | null = null;
  let domainController: string | null = null;
  let lastBindCheck:    string | null = null;

  // Run dsconfigad -show to get AD binding details
  try {
    const { stdout } = await execAsync(
      "dsconfigad -show 2>&1",
      { maxBuffer: 2 * 1024 * 1024 },
    );

    if (stdout.includes("There is no Active Directory binding")) {
      isBound = false;
    } else {
      // Parse domain
      const domainMatch = stdout.match(/Active Directory Domain\s*=\s*(.+)/i);
      if (domainMatch) {
        domain  = domainMatch[1].trim();
        isBound = true;
      }

      // Parse domain controller
      const dcMatch = stdout.match(/Preferred Domain controller\s*=\s*(.+)/i);
      if (dcMatch) domainController = dcMatch[1].trim();

      // Parse last bind check from directory services logs if available
      const bindingMatch = stdout.match(/Computer Account\s*=\s*(.+)/i);
      if (bindingMatch) lastBindCheck = `Computer account: ${bindingMatch[1].trim()}`;
    }
  } catch (err) {
    const msg = (err as Error).message ?? "dsconfigad failed";
    errors.push(msg);
  }

  // Confirm by listing /Active Directory domains
  if (isBound) {
    try {
      const { stdout } = await execAsync(
        `dscl "/Active Directory/" -list / 2>/dev/null`,
        { maxBuffer: 1 * 1024 * 1024, shell: "/bin/bash" },
      );
      const listed = stdout.trim().split("\n").filter(Boolean);
      if (listed.length > 0 && !domain) {
        domain = listed[0];
      }
    } catch (err) {
      errors.push(`dscl listing failed: ${(err as Error).message}`);
    }
  }

  return { isBound, domain, domainController, lastBindCheck, errors };
}

// -- win32 implementation -----------------------------------------------------

async function checkAdBindingWin32(): Promise<AdBindingInfo> {
  const errors: string[] = [];

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$cs = Get-WmiObject Win32_ComputerSystem
$isBound = [bool]$cs.PartOfDomain
$domain  = if ($isBound) { $cs.Domain } else { $null }
$dc      = $null
$lastCheck = $null
if ($isBound) {
  try {
    $d   = [System.DirectoryServices.ActiveDirectory.Domain]::GetCurrentDomain()
    $dc  = $d.PdcRoleOwner.Name
    $lastCheck = (Get-Date).ToString('o')
  } catch {
    # domain unreachable
  }
}
[PSCustomObject]@{
  isBound          = $isBound
  domain           = $domain
  domainController = $dc
  lastBindCheck    = $lastCheck
  errors           = @()
} | ConvertTo-Json -Compress`.trim();

  try {
    const raw    = await runPS(ps);
    const parsed = JSON.parse(raw) as AdBindingInfo;
    return parsed;
  } catch (err) {
    errors.push((err as Error).message);
    return { isBound: false, domain: null, domainController: null, lastBindCheck: null, errors };
  }
}

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}) {
  const platform = os.platform();

  const info = platform === "win32"
    ? await checkAdBindingWin32()
    : await checkAdBindingDarwin();

  return { platform, ...info };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
