/**
 * mcp/skills/surveyNetwork.ts — survey_network
 *
 * Coarse-grained read: reachability, interfaces and Wi-Fi link quality in one
 * call. Replaces the `check_connectivity` → `get_network_interfaces` →
 * `get_wifi_info` opening that every network workflow runs.
 *
 * Why coarse
 * ----------
 * A technician reads all three at once; nothing branches between them. Splitting
 * them into three plan steps costs three executor iterations, and each iteration
 * re-sends the plan, the tool schemas and the whole scratchpad. Merging them
 * removes two iterations from every run of the skill — the term that plan-time
 * pruning could not touch, because pruning only removes steps that were never
 * going to execute.
 *
 * The fine-grained tools remain registered and are NOT deprecated. Bundled
 * skills use this; an admin writing their own skill can compose the three
 * directly when they want to make the choices this tool makes for them.
 *
 * What it decides, and what it refuses to decide
 * ----------------------------------------------
 * It computes `targetInterface` — the rule that used to live in SKILL.md prose
 * ("use primaryInterface; if null fall back to the active physical interface")
 * and was emitted twice per plan, in `notes` and again in an `inputsFrom`
 * description. That is a fact with one right answer, so it belongs in code.
 *
 * It does NOT classify the fault. Whether "IPs reachable but google.com failing"
 * means DNS is a judgement the skill makes from the fields below — moving that
 * here would turn a survey into a diagnosis and take the decision away from the
 * model. See docs/gtm/STRENGTHS.md on why skills stay prose.
 *
 * Audit visibility: the full `interfaces[]` list is returned alongside
 * `targetInterface`, so a reader can always see what the choice was made from.
 */

import {
  run as checkConnectivity,
  meta as connectivityMeta,
} from "./checkConnectivity";
import { run as getNetworkInterfaces } from "./getNetworkInterfaces";
import { run as getWifiInfo }          from "./getWifiInfo";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "survey_network",
  description:
    "Reads the machine's whole network picture in one call: reachability of " +
    "external targets, every network interface, the active uplink, and Wi-Fi " +
    "signal quality when the uplink is Wi-Fi. Read-only. Use at the start of a " +
    "network workflow instead of check_connectivity, get_network_interfaces and " +
    "get_wifi_info separately.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: [
    "platform",
    "targets",
    "allReachable",
    "anyReachable",
    "interfaces",
    "primaryInterface",
    "targetInterface",
    "targetType",
    "targetIpv4",
    "hasApipa",
    "activeCount",
    "wifi",
  ],
  // Borrowed from the tool this one calls so the ping contract cannot drift.
  schema: connectivityMeta.schema,
} as const;

// -- Types --------------------------------------------------------------------

interface SurveyInterface {
  name:   string;
  type:   string;
  status: string;
  ipv4:   string | null;
  ipv6:   string | null;
  mac:    string | null;
  mtu:    number | null;
}

export interface SurveyNetworkResult {
  platform:     string;
  /** Per-target ping results, exactly as check_connectivity returns them. */
  targets:      unknown[];
  allReachable: boolean;
  anyReachable: boolean;
  /** Every interface, so the targetInterface choice below stays auditable. */
  interfaces:   SurveyInterface[];
  /** The OS default-route uplink. Null when there is no default route. */
  primaryInterface: string | null;
  /**
   * The interface a corrective step should act on: `primaryInterface` when set,
   * otherwise the first active physical interface. Null when neither exists —
   * which means a hardware/driver fault or a fully down link, not a fault this
   * skill can repair.
   */
  targetInterface: string | null;
  targetType:      string | null;
  targetIpv4:      string | null;
  /**
   * True when the target interface holds a 169.254.x.x self-assigned address —
   * the signature of a DHCP failure.
   */
  hasApipa:     boolean;
  activeCount:  number;
  /**
   * Wi-Fi link detail, present only when the target interface is Wi-Fi.
   * Null on Ethernet — the caller should report "not applicable", not "poor".
   */
  wifi: unknown | null;
}

// -- Helpers ------------------------------------------------------------------

/** Interfaces a user's traffic can actually leave by. */
const PHYSICAL_TYPES = new Set(["Wi-Fi", "Ethernet"]);

const APIPA = /^169\.254\./;

/**
 * The interface-selection rule, previously prose in every network SKILL.md.
 *
 * Loopback, tunnels and Apple's peer-to-peer links (`awdl0`, `llw0`) are
 * excluded: they are "active" with addresses but carry no user traffic, so
 * picking one sends a DHCP renew at an interface that was never the problem.
 */
export function selectTargetInterface(
  interfaces: SurveyInterface[],
  primaryInterface: string | null,
): SurveyInterface | null {
  if (primaryInterface) {
    const named = interfaces.find((i) => i.name === primaryInterface);
    if (named) return named;
  }
  return (
    interfaces.find(
      (i) => i.status === "active" && PHYSICAL_TYPES.has(i.type),
    ) ?? null
  );
}

// -- Implementation -----------------------------------------------------------

export async function run(
  args: { targets?: string[]; count?: number } = {},
): Promise<SurveyNetworkResult> {
  // Reachability and the interface list are independent — run them together so
  // the merge costs no more wall-clock than the slowest of the two.
  const [conn, ifaces] = await Promise.all([
    checkConnectivity(args),
    getNetworkInterfaces({}),
  ]);

  const interfaces = (ifaces.interfaces ?? []) as SurveyInterface[];
  const primaryInterface = (ifaces.primaryInterface ?? null) as string | null;
  const target = selectTargetInterface(interfaces, primaryInterface);

  // Only read Wi-Fi detail when the uplink is actually Wi-Fi. On Ethernet the
  // tool returns isConnected:false, which reads as a fault if reported bare.
  const wifi = target?.type === "Wi-Fi" ? await getWifiInfo() : null;

  return {
    platform:     (conn.platform ?? ifaces.platform) as string,
    targets:      (conn.targets ?? []) as unknown[],
    allReachable: Boolean(conn.allReachable),
    anyReachable: Boolean(conn.anyReachable),

    interfaces,
    primaryInterface,
    targetInterface: target?.name ?? null,
    targetType:      target?.type ?? null,
    targetIpv4:      target?.ipv4 ?? null,
    hasApipa:        Boolean(target?.ipv4 && APIPA.test(target.ipv4)),
    activeCount:     (ifaces.activeCount ?? 0) as number,

    wifi,
  };
}
