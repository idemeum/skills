/**
 * mcp/skills/surveyVpn.ts — survey_vpn
 *
 * Coarse-grained read: VPN connection state and the profiles available to
 * reconnect with, in one call.
 *
 * Why coarse
 * ----------
 * `check_vpn_status` and `get_vpn_profiles` are never called apart. The second
 * exists mainly to supply `reconnect_vpn`'s `profileName`, so splitting them
 * costs an executor iteration to fetch an argument.
 *
 * The pair also answers one question neither answers alone: whether this
 * machine's VPN is a native profile the agent can drive, or a vendor client it
 * cannot. `reconnect_vpn` returns `vendorManaged` and hands off for the latter,
 * so getting this wrong wastes a corrective.
 *
 * The fine-grained tools remain registered and are NOT deprecated.
 *
 * What it refuses to decide
 * -------------------------
 * Whether to reconnect, and which profile. Picking among several profiles is a
 * question for the user (there is a `wait_for_user_ack` step for exactly that),
 * and whether a reconnect is warranted depends on the reported symptom, which
 * this tool cannot see.
 */

import { run as checkVpnStatus }  from "./checkVpnStatus";
import { run as getVpnProfiles }  from "./getVpnProfiles";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "survey_vpn",
  description:
    "Reads VPN state in one call: active connections, installed vendor clients, " +
    "and every configured profile with its type. Reports whether the machine's " +
    "VPN is a native profile (drivable by reconnect_vpn) or vendor-managed (not). " +
    "Read-only. Use at the start of a VPN workflow instead of check_vpn_status " +
    "and get_vpn_profiles separately.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  // Inherited from get_vpn_profiles, which this tool calls.
  //
  // G4's tccPreflightCheck scans the PLAN's tool metas, not what those tools
  // call internally (execution.ts — it reads meta.tccCategories per step). A
  // wrapper that omits the category silently drops the whole plan-level gate:
  // instead of blocking before any step runs and deep-linking the user to
  // System Settings, the run proceeds and fails mid-flight on a permission
  // error. Any wrapper MUST re-declare the union of what it wraps.
  tccCategories:   ["FullDiskAccess"],
  outputKeys: [
    "platform",
    "isConnected",
    "activeConnections",
    "installedClients",
    "profiles",
    "nativeProfiles",
    "nativeProfileCount",
    "vendorPresent",
  ],
  schema: {},
} as const;

// -- Types --------------------------------------------------------------------

/** Mirrors get_vpn_profiles output. Kept structural so a new field there does
 *  not need an edit here. */
interface VpnProfile {
  name:        string;
  type:        string;
  server:      string | null;
  protocol:    string | null;
  isConnected: boolean;
  lastUsed:    string | null;
}

export interface SurveyVpnResult {
  platform: string;
  isConnected: boolean;
  activeConnections: unknown[];
  /** Vendor clients detected by running process, e.g. "Cisco AnyConnect". */
  installedClients: unknown[];
  /** Every profile, raw — so the nativeProfiles filter below stays auditable. */
  profiles: VpnProfile[];
  /**
   * Profiles `reconnect_vpn` can actually drive. Vendor-managed entries are
   * excluded: the tool returns `vendorManaged` for those and hands off to the
   * vendor app.
   */
  nativeProfiles: VpnProfile[];
  nativeProfileCount: number;
  /**
   * True when a vendor client is installed or a vendor-managed profile exists.
   *
   * Read together with `nativeProfileCount`: zero native profiles AND no vendor
   * client means nothing is configured on this machine at all — on a managed
   * device that points at a configuration profile that was never delivered,
   * which is a different fault from "the VPN will not connect".
   */
  vendorPresent: boolean;
}

const VENDOR_MANAGED = "vendor-managed";

// -- Implementation -----------------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<SurveyVpnResult> {
  const [status, profilesResult] = await Promise.all([
    checkVpnStatus(),
    getVpnProfiles(),
  ]);

  const profiles: VpnProfile[] = profilesResult.profiles ?? [];
  const installedClients = ((status as { installedClients?: unknown[] }).installedClients ?? []);
  const nativeProfiles = profiles.filter((p) => p.type !== VENDOR_MANAGED);

  return {
    platform: process.platform,
    isConnected:       Boolean((status as { isConnected?: boolean }).isConnected),
    activeConnections: ((status as { activeConnections?: unknown[] }).activeConnections ?? []),
    installedClients,
    profiles,
    nativeProfiles,
    nativeProfileCount: nativeProfiles.length,
    vendorPresent:
      installedClients.length > 0 ||
      profiles.some((p) => p.type === VENDOR_MANAGED),
  };
}
