/**
 * mcp/skills/listVideoDevices.ts — list_video_devices skill
 *
 * Enumerates cameras + the system default on macOS and Windows.  Shared
 * between the P0-c Collab App Repair skill and the P0-d A/V & Peripheral
 * Repair skill.
 *
 * Platform strategy
 * -----------------
 * darwin  `system_profiler SPCameraDataType -json` reports each camera
 *         with a unique_id + model_id.  macOS does not have a single
 *         "system default camera" — collab apps pick per-app — but the
 *         built-in FaceTime camera is the conventional default if
 *         present.
 * win32   PowerShell `Get-PnpDevice -Class Camera`.  As on macOS, Windows
 *         does not expose a single default camera across the OS — each
 *         app picks its own.  `defaultCamera` is a best-effort heuristic
 *         (first built-in / integrated camera).
 *
 * Read-only — device mutation lives in `reset_av_device_selection`.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  runPS,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_video_devices",
  description:
    "Enumerates cameras connected to the system (built-in, USB, Continuity " +
    "Camera on macOS) and reports a best-guess default. Use during collab-app " +
    "troubleshooting (Teams/Slack/Zoom/Webex camera problems) or when the " +
    "user reports the wrong camera is being selected. Read-only.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

export interface VideoDevice {
  name:        string;
  connection:  "built-in" | "usb" | "continuity" | "unknown";
  vendorId?:   string;
  productId?:  string;
  isDefault:   boolean;
}

export interface ListVideoDevicesResult {
  platform:       NodeJS.Platform;
  cameras:        VideoDevice[];
  defaultCamera:  string | null;
}

// -- darwin implementation ----------------------------------------------------

interface SPCameraEntry {
  _name:                   string;
  spcamera_model_id?:      string;      // e.g. "Model Id: FaceTime HD Camera"
  spcamera_unique_id?:     string;
}

interface SPCameraData {
  SPCameraDataType?: SPCameraEntry[];
}

function classifyDarwinCamera(entry: SPCameraEntry): VideoDevice["connection"] {
  const model = (entry.spcamera_model_id ?? "").toLowerCase();
  const name  = entry._name.toLowerCase();
  if (name.includes("facetime") || model.includes("apple"))      return "built-in";
  if (name.includes("continuity") || name.includes("iphone"))    return "continuity";
  if (model.includes("usb") || name.includes("logitech") || name.includes("razer")) {
    return "usb";
  }
  return "unknown";
}

function parseDarwinOutput(stdout: string): ListVideoDevicesResult {
  const data     = JSON.parse(stdout) as SPCameraData;
  const items    = data.SPCameraDataType ?? [];
  const cameras: VideoDevice[] = [];
  let defaultCamera: string | null = null;

  for (const entry of items) {
    const connection = classifyDarwinCamera(entry);
    const isDefault  = connection === "built-in" && !defaultCamera;
    const cam: VideoDevice = {
      name: entry._name,
      connection,
      isDefault,
    };
    if (isDefault) defaultCamera = entry._name;
    cameras.push(cam);
  }

  // If no built-in was found, the first camera is the conventional default.
  if (!defaultCamera && cameras.length > 0) {
    cameras[0].isDefault = true;
    defaultCamera = cameras[0].name;
  }

  return {
    platform:      "darwin",
    cameras,
    defaultCamera,
  };
}

async function listVideoDarwin(): Promise<ListVideoDevicesResult> {
  const { stdout } = await execAsync(
    "system_profiler SPCameraDataType -json 2>/dev/null",
    { maxBuffer: 10 * 1024 * 1024 },
  );
  return parseDarwinOutput(stdout);
}

// -- win32 implementation -----------------------------------------------------

interface WinCameraDevice {
  Name:         string;
  Class:        string;
  Status:       string;
  InstanceId?:  string;
  FriendlyName?: string;
}

function classifyWinCamera(d: WinCameraDevice): VideoDevice["connection"] {
  const id   = (d.InstanceId ?? "").toUpperCase();
  const name = d.Name.toLowerCase();
  if (id.includes("USB"))                                      return "usb";
  if (name.includes("integrated") || name.includes("built-in") || id.includes("MIPI")) {
    return "built-in";
  }
  return "unknown";
}

function parseWinVidIdPid(instanceId: string | undefined): { vendorId?: string; productId?: string } {
  if (!instanceId) return {};
  const match = instanceId.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
  if (!match) return {};
  return { vendorId: match[1].toUpperCase(), productId: match[2].toUpperCase() };
}

function parseWinOutput(stdout: string): ListVideoDevicesResult {
  const parsed = stdout.trim()
    ? (JSON.parse(stdout) as WinCameraDevice | WinCameraDevice[])
    : [];
  const devices: WinCameraDevice[] = Array.isArray(parsed) ? parsed : [parsed];

  const cameras: VideoDevice[] = devices
    .filter((d) => d?.Name)
    .map((d) => {
      const connection = classifyWinCamera(d);
      const { vendorId, productId } = parseWinVidIdPid(d.InstanceId);
      return {
        name: d.Name,
        connection,
        ...(vendorId  && { vendorId }),
        ...(productId && { productId }),
        isDefault: false,
      };
    });

  // Windows: first built-in camera (if any) is the conventional default,
  // otherwise the first camera returned.  Apps make their own selection.
  let defaultCamera: string | null = null;
  const firstBuiltin = cameras.find((c) => c.connection === "built-in");
  if (firstBuiltin) {
    firstBuiltin.isDefault = true;
    defaultCamera = firstBuiltin.name;
  } else if (cameras.length > 0) {
    cameras[0].isDefault = true;
    defaultCamera = cameras[0].name;
  }

  return { platform: "win32", cameras, defaultCamera };
}

async function listVideoWin32(): Promise<ListVideoDevicesResult> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-PnpDevice -Class Camera,Image | Where-Object { $_.Status -eq 'OK' -or $_.Status -eq 'Error' } |
  Select-Object Name, Class, Status, InstanceId, FriendlyName |
  ConvertTo-Json -Depth 2 -Compress`.trim();
  const raw = await runPS(script);
  return parseWinOutput(raw);
}

// -- Exported run function ----------------------------------------------------

export async function run(): Promise<ListVideoDevicesResult> {
  const platform = os.platform();
  if (platform === "darwin") return listVideoDarwin();
  if (platform === "win32")  return listVideoWin32();
  throw new Error(`list_video_devices: unsupported platform "${platform}"`);
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  parseDarwinOutput,
  parseWinOutput,
  classifyDarwinCamera,
  classifyWinCamera,
  parseWinVidIdPid,
};
