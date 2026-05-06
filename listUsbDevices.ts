/**
 * mcp/skills/listUsbDevices.ts — list_usb_devices skill
 *
 * Enumerates USB devices with vendor/product IDs and power state.  Used
 * by the P0-d A/V & Peripheral Repair skill to flag unresponsive
 * peripherals (docks, hubs, external storage) before deciding whether
 * the symptom is hardware vs software.
 *
 * Platform strategy
 * -----------------
 * darwin  `system_profiler SPUSBDataType -json` returns a recursive tree
 *         of USB controllers and their attached devices.  We flatten the
 *         tree to a single array of leaves (each entry has `_name`,
 *         `vendor_id`, `product_id`, `bus_power`, `current_available`).
 * win32   PowerShell `Get-PnpDevice -Class USB,USBDevice` for the device
 *         list; the Status field (`OK` / `Error` / `Unknown`) maps
 *         directly to power-state guidance.
 *
 * Read-only.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  runPS,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_usb_devices",
  description:
    "Enumerates USB devices attached to the system with vendor/product IDs " +
    "and power state. Use to identify unresponsive peripherals (docks, hubs, " +
    "external storage), confirm a device the user expects to be present is " +
    "actually enumerated, or surface devices in an error/unknown state. " +
    "Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

export interface UsbDevice {
  name:           string;
  vendorId?:      string;
  productId?:     string;
  manufacturer?:  string;
  status:         "ok" | "error" | "unknown";
  /** Raw bus / power values surfaced for debugging. */
  busPowerMa?:    number;
  /** macOS only — short transport string (e.g. "USB 3.1 Bus"). */
  busName?:       string;
}

export interface ListUsbDevicesResult {
  platform: NodeJS.Platform;
  total:    number;
  devices:  UsbDevice[];
}

// -- darwin implementation ----------------------------------------------------

interface SPUsbItem {
  _name:               string;
  vendor_id?:          string;       // "0x046d (Logitech Inc.)"
  product_id?:         string;       // "0x085e"
  manufacturer?:       string;
  bus_power?:          string;       // "500"
  current_available?:  string;
  _items?:             SPUsbItem[];  // nested hubs
}

interface SPUsbBlock {
  _name?:    string;
  _items?:   SPUsbItem[];
}

interface SPUsbData {
  SPUSBDataType?: SPUsbBlock[];
}

function extractHexId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/0x([0-9A-Fa-f]+)/);
  return match ? match[1].toUpperCase().padStart(4, "0").slice(0, 4) : undefined;
}

function flattenDarwinTree(items: SPUsbItem[], busName: string, out: UsbDevice[]): void {
  for (const item of items) {
    // Skip pure controllers / root hubs (no vendor_id at all + has _items).
    // We DO want internal-bus devices like the Apple Internal Keyboard — those
    // have vendor_id even when nested.
    if (item.vendor_id || item.product_id || !item._items) {
      const busPowerMa = item.bus_power ? parseInt(item.bus_power, 10) : undefined;
      const dev: UsbDevice = {
        name:    item._name,
        ...(extractHexId(item.vendor_id)  && { vendorId:  extractHexId(item.vendor_id)! }),
        ...(extractHexId(item.product_id) && { productId: extractHexId(item.product_id)! }),
        ...(item.manufacturer && { manufacturer: item.manufacturer }),
        status:  "ok",
        ...(busPowerMa !== undefined && !Number.isNaN(busPowerMa) && { busPowerMa }),
        busName,
      };
      out.push(dev);
    }
    if (item._items) flattenDarwinTree(item._items, busName, out);
  }
}

function parseDarwinOutput(stdout: string): ListUsbDevicesResult {
  const data   = JSON.parse(stdout) as SPUsbData;
  const blocks = data.SPUSBDataType ?? [];
  const devices: UsbDevice[] = [];
  for (const block of blocks) {
    if (block._items) flattenDarwinTree(block._items, block._name ?? "USB Bus", devices);
  }
  return {
    platform: "darwin",
    total:    devices.length,
    devices,
  };
}

async function listUsbDarwin(): Promise<ListUsbDevicesResult> {
  const { stdout } = await execAsync(
    "system_profiler SPUSBDataType -json 2>/dev/null",
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return parseDarwinOutput(stdout);
}

// -- win32 implementation -----------------------------------------------------

interface WinPnpDevice {
  Name:         string;
  Class:        string;
  Status:       string;       // "OK" | "Error" | "Unknown" | "Disabled"
  Manufacturer?: string;
  InstanceId?:  string;       // contains VID_xxxx&PID_yyyy
}

function parseWinVidPid(instanceId: string | undefined): { vendorId?: string; productId?: string } {
  if (!instanceId) return {};
  const match = instanceId.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
  if (!match) return {};
  return { vendorId: match[1].toUpperCase(), productId: match[2].toUpperCase() };
}

function classifyWinStatus(status: string): UsbDevice["status"] {
  const s = status.toLowerCase();
  if (s === "ok")        return "ok";
  if (s === "error")     return "error";
  return "unknown";
}

function parseWinOutput(stdout: string): ListUsbDevicesResult {
  const parsed = stdout.trim()
    ? (JSON.parse(stdout) as WinPnpDevice | WinPnpDevice[])
    : [];
  const raw: WinPnpDevice[] = Array.isArray(parsed) ? parsed : [parsed];

  const devices: UsbDevice[] = raw
    .filter((d) => d?.Name)
    .map((d) => {
      const { vendorId, productId } = parseWinVidPid(d.InstanceId);
      return {
        name: d.Name,
        ...(vendorId   && { vendorId }),
        ...(productId  && { productId }),
        ...(d.Manufacturer && { manufacturer: d.Manufacturer }),
        status: classifyWinStatus(d.Status),
      };
    });

  return {
    platform: "win32",
    total:    devices.length,
    devices,
  };
}

async function listUsbWin32(): Promise<ListUsbDevicesResult> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-PnpDevice -PresentOnly -Class USB,USBDevice |
  Select-Object Name, Class, Status, Manufacturer, InstanceId |
  ConvertTo-Json -Depth 2 -Compress`.trim();
  const raw = await runPS(script);
  return parseWinOutput(raw);
}

// -- Exported run function ----------------------------------------------------

export async function run(): Promise<ListUsbDevicesResult> {
  const platform = os.platform();
  if (platform === "darwin") return listUsbDarwin();
  if (platform === "win32")  return listUsbWin32();
  throw new Error(`list_usb_devices: unsupported platform "${platform}"`);
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  parseDarwinOutput,
  parseWinOutput,
  parseWinVidPid,
  classifyWinStatus,
  extractHexId,
  flattenDarwinTree,
};
