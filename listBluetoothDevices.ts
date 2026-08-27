/**
 * mcp/skills/listBluetoothDevices.ts — list_bluetooth_devices skill
 *
 * Enumerates paired Bluetooth devices with name, address, connection
 * state, and (where surfaced by the OS) RSSI + battery level.  Used by
 * the P0-d A/V & Peripheral Repair skill to flag flaky / disconnected
 * Bluetooth peripherals (AirPods, mice, keyboards) before deciding
 * whether to reset the Bluetooth module.
 *
 * Platform strategy
 * -----------------
 * darwin  `system_profiler SPBluetoothDataType -json`.  The macOS report
 *         has a specific shape: a tree where the top-level entry has
 *         "device_connected" (paired AND currently connected) and
 *         "device_not_connected" (paired but offline) sub-objects.
 * win32   PowerShell `Get-PnpDevice -Class Bluetooth` for the device
 *         list; battery + RSSI are not consistently exposed by Windows
 *         APIs from PowerShell, so those fields are reported as
 *         undefined on win32 unless `BluetoothLEAdvertisement` reports
 *         them (out of scope for the alpha).
 *
 * Read-only — device pair / unpair / module reset are separate tools.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  runPS,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_bluetooth_devices",
  description:
    "Enumerates paired Bluetooth devices (connected and offline) with name, " +
    "address, connection state, and where supported RSSI + battery percent. " +
    "Use when troubleshooting flaky Bluetooth peripherals — a paired device " +
    "showing as not-connected when the user expects it to be active is the " +
    "primary signal. Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: ["platform","poweredOn","total","devices"],
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

export interface BluetoothDevice {
  name:           string;
  address?:       string;
  /** Whether the device is currently connected. */
  connected:      boolean;
  /** Whether the device is paired (always true on darwin output, may be inferred on win32). */
  paired:         boolean;
  /** RSSI in dBm if reported by the OS. */
  rssi?:          number;
  /** Battery percentage if reported. */
  batteryPercent?: number;
  /** Vendor ID where surfaced. */
  vendorId?:      string;
  productId?:     string;
}

export interface ListBluetoothDevicesResult {
  platform:    NodeJS.Platform;
  poweredOn:   boolean;
  total:       number;
  devices:     BluetoothDevice[];
}

// -- darwin implementation ----------------------------------------------------

interface SPBluetoothEntry {
  /** Each device is a single-key object: { "<deviceName>": { ...details } } */
  [name: string]: {
    device_address?:        string;
    device_minorType?:      string;         // macOS 13+ ("Headphones", "Keyboard")
    device_majorType?:      string;
    /**
     * Battery.  macOS 13+ uses camelCase after the `device_` prefix and
     * splits AirPods-style devices into left / right / case with no "main";
     * pre-Ventura used the snake_case `device_battery_level_main`.
     */
    device_batteryLevelMain?:  string;      // "85%"
    device_batteryLevelLeft?:  string;
    device_batteryLevelRight?: string;
    device_batteryLevelCase?:  string;
    device_battery_level_main?: string;     // pre-Ventura key
    device_rssi?:            string;
    device_vendorID?:        string;
    device_productID?:       string;
  };
}

interface SPBluetoothControllerInfo {
  /**
   * macOS 13+ reports `"attrib_on"` / `"attrib_off"`; older builds reported
   * `"On"` / `"Off"`.  Never compare against a single literal — see
   * `isControllerOn`.
   */
  controller_state?: string;
  device_title?: string;
  general_device_status?: string;
}

/** Spans the macOS 13+ `attrib_on` form and the legacy `On` form. */
function isControllerOn(state: string | undefined): boolean {
  const s = (state ?? "").trim().toLowerCase();
  return s === "attrib_on" || s === "on";
}

interface SPBluetoothBlock {
  device_title?:                string;
  controller_properties?:       SPBluetoothControllerInfo;
  device_connected?:            SPBluetoothEntry[];
  device_not_connected?:        SPBluetoothEntry[];
}

interface SPBluetoothData {
  SPBluetoothDataType?: SPBluetoothBlock[];
}

function parseBatteryDarwin(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/(\d+)\s*%?/);
  if (!match) return undefined;
  const n = parseInt(match[1], 10);
  return Number.isNaN(n) ? undefined : n;
}

function parseRssiDarwin(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/-?\d+/);
  if (!match) return undefined;
  const n = parseInt(match[0], 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Picks the most representative battery reading.  Prefers an explicit
 * "main" level; for split devices (AirPods) falls back to the LOWER of the
 * two buds — that is the one that will die first, which is what the user
 * needs to act on.  The case level is deliberately ignored (it doesn't
 * affect whether the device can connect).
 */
function pickBatteryDarwin(details: SPBluetoothEntry[string]): number | undefined {
  const main = parseBatteryDarwin(
    details.device_batteryLevelMain ?? details.device_battery_level_main,
  );
  if (main !== undefined) return main;

  const buds = [
    parseBatteryDarwin(details.device_batteryLevelLeft),
    parseBatteryDarwin(details.device_batteryLevelRight),
  ].filter((n): n is number => n !== undefined);

  return buds.length > 0 ? Math.min(...buds) : undefined;
}

function flattenDarwinDevices(entries: SPBluetoothEntry[], connected: boolean, out: BluetoothDevice[]): void {
  for (const entry of entries) {
    for (const [name, details] of Object.entries(entry)) {
      const battery = pickBatteryDarwin(details);
      const rssi    = parseRssiDarwin(details.device_rssi);
      const dev: BluetoothDevice = {
        name,
        ...(details.device_address && { address: details.device_address }),
        connected,
        paired:    true,
        ...(battery !== undefined && { batteryPercent: battery }),
        ...(rssi !== undefined && { rssi }),
        ...(details.device_vendorID  && { vendorId:  details.device_vendorID  }),
        ...(details.device_productID && { productId: details.device_productID }),
      };
      out.push(dev);
    }
  }
}

function parseDarwinOutput(stdout: string): ListBluetoothDevicesResult {
  const data   = JSON.parse(stdout) as SPBluetoothData;
  const blocks = data.SPBluetoothDataType ?? [];
  const devices: BluetoothDevice[] = [];
  let poweredOn = false;

  for (const block of blocks) {
    if (isControllerOn(block.controller_properties?.controller_state)) poweredOn = true;
    if (block.device_connected)     flattenDarwinDevices(block.device_connected,     true,  devices);
    if (block.device_not_connected) flattenDarwinDevices(block.device_not_connected, false, devices);
  }

  return {
    platform: "darwin",
    poweredOn,
    total:    devices.length,
    devices,
  };
}

async function listBluetoothDarwin(): Promise<ListBluetoothDevicesResult> {
  const { stdout } = await execAsync(
    "system_profiler SPBluetoothDataType -json 2>/dev/null",
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return parseDarwinOutput(stdout);
}

// -- win32 implementation -----------------------------------------------------

interface WinBluetoothDevice {
  Name:        string;
  Class:       string;
  Status:      string;       // "OK" | "Error" | "Unknown"
  Present:     boolean;
  InstanceId?: string;       // contains BTHENUM\Dev_<address>
  Manufacturer?: string;
}

function extractWinAddress(instanceId: string | undefined): string | undefined {
  if (!instanceId) return undefined;
  // BTHENUM\Dev_<12-hex-digit-address>\...
  const match = instanceId.match(/Dev_([0-9A-Fa-f]{12})/);
  if (!match) return undefined;
  // Format as XX:XX:XX:XX:XX:XX
  const hex = match[1].toUpperCase();
  return `${hex.slice(0,2)}:${hex.slice(2,4)}:${hex.slice(4,6)}:${hex.slice(6,8)}:${hex.slice(8,10)}:${hex.slice(10,12)}`;
}

function parseWinOutput(stdout: string, controllerOk: boolean): ListBluetoothDevicesResult {
  const parsed = stdout.trim()
    ? (JSON.parse(stdout) as WinBluetoothDevice | WinBluetoothDevice[])
    : [];
  const raw: WinBluetoothDevice[] = Array.isArray(parsed) ? parsed : [parsed];

  const devices: BluetoothDevice[] = raw
    .filter((d) => d?.Name && d.Class === "Bluetooth")
    .map((d) => {
      const address = extractWinAddress(d.InstanceId);
      // PnP "Present + Status=OK" maps to connected; "Present + Status=Unknown"
      // typically means paired-but-asleep (e.g. AirPods in case).
      const connected = d.Present && d.Status === "OK";
      const paired    = d.Present;
      return {
        name: d.Name,
        ...(address && { address }),
        connected,
        paired,
      };
    });

  return {
    platform: "win32",
    poweredOn: controllerOk,
    total:    devices.length,
    devices,
  };
}

async function listBluetoothWin32(): Promise<ListBluetoothDevicesResult> {
  const devicesScript = `
$ErrorActionPreference = 'SilentlyContinue'
Get-PnpDevice -Class Bluetooth |
  Select-Object Name, Class, Status, Present, InstanceId, Manufacturer |
  ConvertTo-Json -Depth 2 -Compress`.trim();

  const controllerScript = `
$ErrorActionPreference = 'SilentlyContinue'
$svc = Get-Service -Name bthserv -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { 'on' } else { 'off' }`.trim();

  const [rawDevices, rawController] = await Promise.all([
    runPS(devicesScript),
    runPS(controllerScript),
  ]);

  const controllerOk = rawController.trim().toLowerCase() === "on";
  return parseWinOutput(rawDevices, controllerOk);
}

// -- Exported run function ----------------------------------------------------

export async function run(): Promise<ListBluetoothDevicesResult> {
  const platform = os.platform();
  if (platform === "darwin") return listBluetoothDarwin();
  if (platform === "win32")  return listBluetoothWin32();
  throw new Error(`list_bluetooth_devices: unsupported platform "${platform}"`);
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  parseDarwinOutput,
  parseWinOutput,
  parseBatteryDarwin,
  pickBatteryDarwin,
  parseRssiDarwin,
  isControllerOn,
  extractWinAddress,
  flattenDarwinDevices,
};
