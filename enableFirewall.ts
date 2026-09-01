/**
 * mcp/skills/enableFirewall.ts — enable_firewall skill
 *
 * Turns the OS firewall on. Read-only counterpart: `check_firewall_status`.
 *
 * Enable only — never disable
 * ---------------------------
 * There is no parameter to switch the firewall off and no code path that could.
 * A support agent disabling a firewall is a compliance violation and an attack
 * primitive; `security-agent-repair` already declines requests to weaken
 * security posture, and this tool holds the same line at the tool boundary.
 *
 * Why it exists
 * -------------
 * A user who switched the firewall off is a common cause of an MDM compliance
 * policy failing — and one that re-pushing policy does NOT fix, because the
 * policy is already assigned and applied. It is the local half of "device
 * compliance fix": Intune reports which rule fails, this puts the machine back
 * on the right side of it.
 *
 * Platform strategy
 * -----------------
 * darwin  `/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on`
 *         — global state only; stealth mode and per-app rules are left alone,
 *         since tightening those unasked can break working software.
 * win32   `netsh advfirewall set allprofiles state on` — all three profiles,
 *         because a compliance rule fails if any one of them is off.
 *
 * Both need admin and route through the privileged helper daemon
 * (op `enable_firewall`).
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/enableFirewall.ts
 */

import * as os       from "os";
import { z }         from "zod";
import { execAsync } from "./_shared/platform";

const EXEC_TIMEOUT_MS = 15_000;
const SOCKETFILTERFW  = "/usr/libexec/ApplicationFirewall/socketfilterfw";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "enable_firewall",
  description:
    "Turns the operating system firewall on. Use when a compliance check reports " +
    "the firewall is disabled. Cannot disable a firewall — there is no such option.",
  // Medium, not high: it tightens security posture and destroys no configuration.
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on",
    win32:  "netsh advfirewall set allprofiles state on  # run from elevated PowerShell",
  },
  outputKeys: ["enabled","dryRun","message","platform"],
  schema: {
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("If true, report what would change without enabling. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface EnableFirewallResult {
  enabled:  boolean;
  dryRun:   boolean;
  message:  string;
  platform: string;
}

// -- Exported run function ----------------------------------------------------

/**
 * Local implementation. In production G4 routes the real call through the
 * privileged helper (`affectedScope` includes "system"); this body serves the
 * dry-run preview and the helper-unavailable path.
 */
export async function run({
  dryRun = true,
}: {
  dryRun?: boolean | null;
} = {}): Promise<EnableFirewallResult> {
  const platform = os.platform();

  if (dryRun !== false) {
    return {
      enabled:  false,
      dryRun:   true,
      message:
        platform === "win32"
          ? "Dry run: would turn the firewall on for all three profiles (domain, private, public). Existing rules are unchanged."
          : "Dry run: would turn the firewall on. Stealth mode and per-application rules are unchanged.",
      platform,
    };
  }

  try {
    if (platform === "win32") {
      await execAsync("netsh advfirewall set allprofiles state on", { timeout: EXEC_TIMEOUT_MS });
    } else {
      await execAsync(`${SOCKETFILTERFW} --setglobalstate on`, { timeout: EXEC_TIMEOUT_MS });
    }
  } catch (e) {
    return {
      enabled:  false,
      dryRun:   false,
      message:  `Failed to enable the firewall: ${(e as Error).message}. This needs administrator rights — the privileged helper was not available.`,
      platform,
    };
  }

  return {
    enabled:  true,
    dryRun:   false,
    message:  "Firewall enabled. Re-run check_firewall_status to confirm the new state.",
    platform,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({})
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
