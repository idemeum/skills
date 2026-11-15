/**
 * mcp/skills/cRmmDiagnoseDevice.ts — c_rmm_diagnose_device
 *
 * Provider-neutral, read-only RMM lookup: finds this machine in the RMM that
 * manages it and reads the facts a skill asks for — device details, health,
 * active alerts, disk volumes, failed OS patches. The RMM counterpart of
 * c_mdm_diagnose_configuration (decided 2026-11-15): skills never name a
 * vendor, one call replaces a find-then-read chain of steps, and the vendor's
 * quirks are rules in code rather than prose for the executor to re-apply.
 *
 * Backend: chosen from `managedBy` (ctx.deviceManagedBy — the connectors
 * appmanagement says know this machine's serial). NinjaOne is wired. An RMM
 * never depends on an MDM: this tool reads no MDM state, and runs on a machine
 * with no MDM at all.
 *
 * NinjaOne's quirks, enforced here:
 *   - Its device search also matches names and IP addresses, and serials are
 *     not guaranteed unique, so a match is trusted only when `matchCount` is 1
 *     AND `matchAttr` names the serial. Otherwise no facet is read: a name or
 *     IP match could describe a different machine.
 *   - Timestamps are Unix seconds; they are returned as ISO-8601 strings.
 *
 * UNVERIFIED against a live gateway: the response shapes are the catalog's
 * outputKeys (connectorcatalog connectors/ninjaone.yaml), and whether
 * NinjaOne's search matches serials at all is not yet confirmed.
 */

import { z } from "zod";

import { runCatalogTool, type CatalogToolResult } from "./_shared/catalogExecutor";
import { pickBackend, type DeviceToolContext }     from "./_shared/deviceProviders";

// -- Facets -------------------------------------------------------------------

export const RMM_FACETS = ["info", "health", "alerts", "disks", "patches"] as const;
export type RmmFacet = (typeof RMM_FACETS)[number];

// -- Provider backends --------------------------------------------------------

/** What a backend's device lookup must produce, whatever the vendor. */
interface BackendDevice {
  status:        "ok" | "failed" | "not-configured";
  message:       string;
  matchCount?:   number;
  /** True only when the single match was on the hardware serial. */
  serialMatch?:  boolean;
  deviceName?:   string;
  offline?:      boolean;
  lastCheckIn?:  string;
}

interface RmmBackend {
  /** The connector this backend calls — matched against `managedBy`. */
  connectorId: string;
  /** The provider's name, as the user and IT know it. */
  label:       string;
  findDevice(ctx?: DeviceToolContext): Promise<BackendDevice>;
  readFacet(facet: RmmFacet, ctx?: DeviceToolContext): Promise<{ ok: boolean; message: string; fields: Record<string, unknown> }>;
}

/** NinjaOne's operation per facet. */
const NINJAONE_FACET_TOOLS: Record<RmmFacet, string> = {
  info:    "c_ninjaone_get_device_info",
  health:  "c_ninjaone_get_device_health",
  alerts:  "c_ninjaone_get_device_alerts",
  disks:   "c_ninjaone_get_disk_volumes",
  patches: "c_ninjaone_get_os_patches",
};

const BACKENDS: RmmBackend[] = [
  {
    connectorId: "ninjaone",
    label:       "NinjaOne",
    findDevice: async (ctx) => {
      const r = await runCatalogTool("c_ninjaone_find_device", {}, ctx);
      if (r.status !== "ok") return { status: r.status, message: r.message };
      const matchAttr = typeof r["matchAttr"] === "string" ? r["matchAttr"] : "";
      return {
        status:      "ok",
        message:     r.message,
        matchCount:  typeof r["matchCount"] === "number" ? r["matchCount"] : 0,
        serialMatch: /serial/i.test(matchAttr),
        deviceName:  typeof r["deviceName"] === "string" ? r["deviceName"] : undefined,
        offline:     typeof r["offline"] === "boolean" ? r["offline"] : undefined,
        lastCheckIn: unixToIso(r["lastCheckIn"]),
      };
    },
    readFacet: async (facet, ctx) => {
      const r = await runCatalogTool(NINJAONE_FACET_TOOLS[facet], {}, ctx);
      return { ok: r.status === "ok", message: r.message, fields: ninjaOneFields(facet, r) };
    },
  },
];

/** The neutral fields of one NinjaOne facet — flat, timestamps as ISO. */
function ninjaOneFields(facet: RmmFacet, r: CatalogToolResult): Record<string, unknown> {
  if (r.status !== "ok") return {};
  const pick = (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
  switch (facet) {
    case "info":
      return {
        ...pick(["osName", "osBuild", "architecture", "needsReboot", "manufacturer", "model",
                 "totalMemoryBytes", "domain", "lastLoggedInUser", "ipAddresses"]),
        ...(r["lastBootTime"] !== undefined && { lastBootTime: unixToIso(r["lastBootTime"]) }),
      };
    case "health":
      return pick(["healthStatus", "activeThreatsCount", "quarantinedThreatsCount",
                   "failedOsPatchesCount", "pendingOsPatchesCount", "failedSoftwarePatchesCount",
                   "pendingSoftwarePatchesCount", "alertCount", "pendingRebootReason",
                   "avInstallStatus", "criticalVulnerabilityCount", "highVulnerabilityCount",
                   "installationIssuesCount"]);
    case "alerts":
      return {
        alerts: (Array.isArray(r["alerts"]) ? r["alerts"] : []).map((a) => {
          const alert = (a ?? {}) as Record<string, unknown>;
          return alert["createTime"] !== undefined
            ? { ...alert, createTime: unixToIso(alert["createTime"]) }
            : alert;
        }),
      };
    case "disks":
      return { volumes: Array.isArray(r["volumes"]) ? r["volumes"] : [] };
    case "patches":
      return { failedPatches: Array.isArray(r["patches"]) ? r["patches"] : [] };
  }
}

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "c_rmm_diagnose_device",
  description:
    "Read-only RMM check: finds this device in the RMM that manages it and reads " +
    "the facets asked for — info (OS, model, memory, IP addresses, last user), " +
    "health (threats, antivirus, patch and vulnerability counts, pending reboot), " +
    "alerts (active alerts), disks (free space, BitLocker) and patches (failed OS " +
    "patches). Makes no changes. Reports `outcome`: found, or why the device could " +
    "not be read (not-managed, not-found, ambiguous-match, lookup-failed, …).",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  auditRequired:   true,
  affectedScope:   ["network"],
  // Subject is this endpoint's hardware serial, injected by G4 — never a parameter.
  requiresDeviceSerial: true,
  // Read-only cloud lookup: passes G4's network-tier admin-or-MDM test.
  kind:            "diagnostic",
  // The planner leaves this step out when no listed RMM manages this machine.
  deviceProviders: BACKENDS.map((b) => b.connectorId),
  sensitiveParams: [],
  outputKeys: [
    "outcome", "message", "provider", "serialNumber", "matchCount", "deviceName",
    "offline", "lastCheckIn",
    "osName", "osBuild", "architecture", "needsReboot", "lastBootTime", "manufacturer",
    "model", "totalMemoryBytes", "domain", "lastLoggedInUser", "ipAddresses",
    "healthStatus", "activeThreatsCount", "quarantinedThreatsCount", "failedOsPatchesCount",
    "pendingOsPatchesCount", "failedSoftwarePatchesCount", "pendingSoftwarePatchesCount",
    "alertCount", "pendingRebootReason", "avInstallStatus", "criticalVulnerabilityCount",
    "highVulnerabilityCount", "installationIssuesCount",
    "alerts", "volumes", "failedPatches", "facetErrors",
  ],
  schema: {
    facets: z
      .array(z.enum(RMM_FACETS))
      .min(1)
      .describe(
        "Which facts to read: 'info' (OS, model, memory, IPs, last user), 'health' " +
        "(threats, antivirus, patch and vulnerability counts, pending reboot), " +
        "'alerts' (active alerts), 'disks' (volumes, free space, BitLocker), " +
        "'patches' (failed OS patches). Ask only for what the workflow names.",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

/**
 * Every terminal state. The skill reports the outcome it gets rather than
 * re-deriving it from raw fields.
 */
export type RmmDiagnoseOutcome =
  | "not-managed"       // no RMM this agent can reach manages this machine
  | "serial-unreadable" // no usable hardware serial (common on VMs)
  | "not-configured"    // gateway URL or API key absent on this machine
  | "lookup-failed"     // gateway reachable but the device lookup failed
  | "not-found"         // the RMM does not know this serial
  | "ambiguous-match"   // several devices match, or the match was not on the serial
  | "found";            // located; the facets read are in the result

export interface RmmDiagnoseResult {
  outcome:       RmmDiagnoseOutcome;
  message:       string;
  provider:      string | null;
  serialNumber:  string | null;
  matchCount?:   number;
  deviceName?:   string;
  offline?:      boolean;
  lastCheckIn?:  string;
  /** A facet that could not be read, and why. Empty when all were read. */
  facetErrors?:  { facet: RmmFacet; message: string }[];
  [field: string]: unknown;
}

// -- Helpers ------------------------------------------------------------------

/** Unix seconds (number or numeric string) → ISO-8601; anything else → undefined. */
export function unixToIso(value: unknown): string | undefined {
  const n = typeof value === "number" ? value
          : typeof value === "string" && value.trim() !== "" ? Number(value)
          : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

// -- Implementation -----------------------------------------------------------

export async function run(
  args: { facets?: readonly RmmFacet[] | null } = {},
  ctx?: DeviceToolContext,
): Promise<RmmDiagnoseResult> {
  const facets = [...new Set((args.facets ?? []).filter((f) => RMM_FACETS.includes(f)))];

  // First: with no serial, the startup lookup could not ask anyone, so an
  // empty managedBy would otherwise read as "no RMM manages this device".
  if (!ctx?.deviceSerial) {
    return {
      outcome: "serial-unreadable", provider: null, serialNumber: null,
      message: "This device's hardware serial could not be read, so it cannot be located in an RMM. Common on virtual machines.",
    };
  }

  const backend = pickBackend(BACKENDS, ctx.deviceManagedBy);
  if (!backend) {
    return {
      outcome: "not-managed", provider: null, serialNumber: ctx.deviceSerial,
      message: "No RMM connected to this tenant manages this device.",
    };
  }
  const provider = backend.label;
  const common = { provider, serialNumber: ctx.deviceSerial };

  const found = await backend.findDevice(ctx);
  if (found.status === "not-configured") return { outcome: "not-configured", message: found.message, ...common };
  if (found.status !== "ok") {
    return { outcome: "lookup-failed", message: `Could not look up this device in ${provider}: ${found.message}`, ...common };
  }

  const matchCount = found.matchCount ?? 0;
  if (matchCount === 0) {
    return { outcome: "not-found", message: `Not found in ${provider}.`, ...common, matchCount };
  }
  if (matchCount > 1 || !found.serialMatch) {
    return {
      outcome: "ambiguous-match",
      message: matchCount > 1
        ? `Several ${provider} devices match this serial, so none is read.`
        : `${provider} matched a device on something other than its serial, so it may be a different machine and is not read.`,
      ...common, matchCount,
    };
  }

  const reads = await Promise.all(facets.map(async (facet) => ({ facet, ...(await backend.readFacet(facet, ctx)) })));
  const facetErrors = reads.filter((r) => !r.ok).map((r) => ({ facet: r.facet, message: r.message }));
  const fields = Object.assign({}, ...reads.map((r) => r.fields)) as Record<string, unknown>;

  return {
    outcome: "found",
    message: facetErrors.length === 0
      ? `Found in ${provider}; read ${facets.join(", ") || "no facets"}.`
      : `Found in ${provider}; could not read ${facetErrors.map((e) => e.facet).join(", ")}.`,
    ...common,
    matchCount,
    deviceName:  found.deviceName,
    offline:     found.offline,
    lastCheckIn: found.lastCheckIn,
    ...fields,
    facetErrors,
  };
}
