/**
 * mcp/skills/disableProxy.ts — disable_proxy skill
 *
 * Switches the system proxy OFF for one network service, leaving the
 * configured server and port in place. The read-only counterpart is
 * `check_proxy_settings`, which reports what is currently set.
 *
 * Why disable rather than clear
 * -----------------------------
 * Clearing the address (`networksetup -setwebproxy "" 0`) would lose a
 * setting the user may need again — a corporate proxy that is merely
 * unreachable right now is still the correct configuration for the office.
 * Flipping only the state is one toggle away from reversible in the OS UI,
 * which makes this the least-destructive fix for the common fault: a stale
 * proxy left behind by a VPN or a captive portal.
 *
 * Platform strategy
 * -----------------
 * darwin  `networksetup -setwebproxystate / -setsecurewebproxystate /
 *         -setautoproxystate "<service>" off` — admin, routed through the
 *         privileged helper daemon (op `disable_proxy`).
 * win32   HKCU Internet Settings `ProxyEnable=0` — per-user, but routed
 *         through the same helper op for a uniform audit trail.
 *
 * Never touches WinHTTP (`netsh winhttp`): that is the system-service proxy,
 * is not what `check_proxy_settings` reads, and resetting it can break
 * Windows Update and other service traffic.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/disableProxy.ts
 */

import * as os       from "os";
import { z }         from "zod";
import { execAsync } from "./_shared/platform";

const EXEC_TIMEOUT_MS = 15_000;

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "disable_proxy",
  description:
    "Switches the system proxy off for a network service, leaving the configured " +
    "server and port intact so it can be re-enabled from System Settings. " +
    "Use when check_proxy_settings shows an enabled proxy pointing at an " +
    "unreachable server — the classic 'I have internet but no websites load'.",
  // Medium, not high: this flips a reversible state flag and destroys no
  // configuration. reset_network_settings is high because it discards custom
  // locations, static IPs and manual DNS.
  riskLevel:       "medium",
  destructive:     false,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["network", "system"],
  auditRequired:   true,
  escalationHint:  {
    darwin: "sudo networksetup -setwebproxystate \"<service>\" off  # repeat for -setsecurewebproxystate / -setautoproxystate",
    win32:  "Settings → Network & Internet → Proxy → turn off \"Use a proxy server\"",
  },
  outputKeys: ["interface","disabled","dryRun","message","platform"],
  schema: {
    // snake_case-free: the helper's Params field is `interface`, and G4
    // forwards executor params verbatim, so this name is the wire contract.
    interface: z
      .string()
      .describe(
        "Network service to disable the proxy on. macOS: the service name as " +
        "shown in System Settings → Network (e.g. \"Wi-Fi\", \"Ethernet\"). " +
        "Windows: accepted for parity but unused — the proxy is per-user.",
      ),
    protocols: z
      .array(z.enum(["web", "secureweb", "auto"]))
      .nullable().optional()
      .describe(
        "Which proxy kinds to switch off. Omit to disable all three.",
      ),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe("If true, report what would be disabled without changing anything. Default: true"),
  },
} as const;

// -- Types --------------------------------------------------------------------

type Protocol = "web" | "secureweb" | "auto";

const ALL_PROTOCOLS: Protocol[] = ["web", "secureweb", "auto"];

interface DisableProxyResult {
  interface: string;
  disabled:  Protocol[];
  dryRun:    boolean;
  message:   string;
  platform:  string;
}

// -- Exported run function ----------------------------------------------------

/**
 * Local implementation. In production G4 routes the real call through the
 * privileged helper (`affectedScope` includes "system"); this body serves the
 * dry-run preview and the helper-unavailable path, where it fails cleanly
 * rather than half-applying.
 */
export async function run({
  interface: iface,
  protocols,
  dryRun = true,
}: {
  interface:  string;
  protocols?: Protocol[] | null;
  dryRun?:    boolean | null;
}): Promise<DisableProxyResult> {
  const platform = os.platform();
  const targets  = protocols && protocols.length > 0 ? protocols : ALL_PROTOCOLS;

  if (!iface || !iface.trim()) {
    throw new Error("[disable_proxy] 'interface' is required (network service name).");
  }

  if (dryRun !== false) {
    return {
      interface: iface,
      disabled:  targets,
      dryRun:    true,
      message:
        platform === "win32"
          ? `Dry run: would set ProxyEnable=0 for the current user (${targets.join(", ")}). The proxy address is kept so it can be switched back on.`
          : `Dry run: would switch off ${targets.join(", ")} proxy on "${iface}". The server and port are kept so it can be switched back on.`,
      platform,
    };
  }

  // Real execution normally happens in the helper. Reaching here means the
  // helper was unavailable and G4 fell back — attempt locally and let the
  // caller surface a permission failure rather than reporting a false success.
  const flags: Record<Protocol, string> = {
    web:       "-setwebproxystate",
    secureweb: "-setsecurewebproxystate",
    auto:      "-setautoproxystate",
  };

  try {
    if (platform === "win32") {
      await execAsync(
        `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
        { timeout: EXEC_TIMEOUT_MS },
      );
    } else {
      for (const p of targets) {
        await execAsync(
          `networksetup ${flags[p]} '${iface.replace(/'/g, "'\\''")}' off`,
          { timeout: EXEC_TIMEOUT_MS },
        );
      }
    }
  } catch (e) {
    return {
      interface: iface,
      disabled:  [],
      dryRun:    false,
      message:   `Failed to disable the proxy on "${iface}": ${(e as Error).message}. This needs administrator rights — the privileged helper was not available.`,
      platform,
    };
  }

  return {
    interface: iface,
    disabled:  targets,
    dryRun:    false,
    message:   `Proxy switched off (${targets.join(", ")}) on "${iface}". The server and port are unchanged, so it can be re-enabled from System Settings.`,
    platform,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ interface: "Wi-Fi" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
