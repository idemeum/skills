/**
 * mcp/skills/listAudioDevices.ts — list_audio_devices skill
 *
 * Enumerates microphones + speakers + the system default on macOS and Windows.
 * Shared between the P0-c Collab App Repair skill and the P0-d A/V &
 * Peripheral Repair skill.
 *
 * Platform strategy
 * -----------------
 * darwin  `system_profiler SPAudioDataType -json` — comprehensive audio
 *         data including per-device default_input / default_output flags.
 * win32   PowerShell `Get-PnpDevice -Class AudioEndpoint` + MMDevice API
 *         via a small PS snippet; falls back to Get-PnpDevice alone if
 *         the default-probe fails.
 *
 * The tool never restarts services or modifies device selection — it is
 * read-only by design.  Device mutation lives in `reset_av_device_selection`.
 */

import * as os from "os";
import { z }   from "zod";

import {
  execAsync,
  runPS,
}                from "./_shared/platform";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "list_audio_devices",
  description:
    "Enumerates microphones and speakers available on the system, flags " +
    "which is the system default for input vs output, and reports connection " +
    "type (built-in / USB / Bluetooth). Use during collab-app troubleshooting " +
    "(Teams/Slack/Zoom/Webex mic or speaker problems) or peripheral audio " +
    "issues. Read-only — does not change device selection.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {} as Record<string, z.ZodTypeAny>,
} as const;

// -- Types --------------------------------------------------------------------

export interface AudioDevice {
  name:         string;
  kind:         "input" | "output";
  connection:   "built-in" | "usb" | "bluetooth" | "hdmi" | "unknown";
  isDefault:    boolean;
  transport?:   string;     // raw platform-specific transport string
}

export interface ListAudioDevicesResult {
  platform:        NodeJS.Platform;
  inputDevices:    AudioDevice[];
  outputDevices:   AudioDevice[];
  defaultInput:    string | null;
  defaultOutput:   string | null;
}

// -- darwin implementation ----------------------------------------------------

interface SPAudioStream {
  _name:                             string;
  coreaudio_default_audio_input_device?:  string;  // "spaudio_yes" when true
  coreaudio_default_audio_output_device?: string;
  coreaudio_default_audio_system_device?: string;
  coreaudio_device_transport?:       string;       // e.g. "coreaudio_device_type_builtin"
  coreaudio_device_input?:           string;
  coreaudio_device_output?:          string;
}

interface SPAudioBlock {
  _name?:    string;
  _items?:   SPAudioStream[];
}

interface SPAudioData {
  SPAudioDataType?: SPAudioBlock[];
}

function classifyDarwinTransport(
  transport: string | undefined,
  name:      string,
): AudioDevice["connection"] {
  const t = (transport ?? "").toLowerCase();
  const n = name.toLowerCase();
  if (t.includes("builtin"))   return "built-in";
  if (t.includes("usb"))       return "usb";
  if (t.includes("bluetooth")) return "bluetooth";
  if (t.includes("hdmi"))      return "hdmi";
  // Heuristic fallback on device name for cases where macOS doesn't surface
  // a transport (common with AirPods / Beats).
  if (n.includes("airpods") || n.includes("beats") || n.includes("bluetooth")) {
    return "bluetooth";
  }
  if (n.includes("usb")) return "usb";
  return "unknown";
}

function parseDarwinOutput(stdout: string): ListAudioDevicesResult {
  const data       = JSON.parse(stdout) as SPAudioData;
  const blocks     = data.SPAudioDataType ?? [];
  const items: SPAudioStream[] = [];
  for (const block of blocks) {
    if (block._items) items.push(...block._items);
  }

  const inputDevices:  AudioDevice[] = [];
  const outputDevices: AudioDevice[] = [];
  let defaultInput:  string | null = null;
  let defaultOutput: string | null = null;

  for (const item of items) {
    const name      = item._name;
    const isInput   = item.coreaudio_device_input  === "spaudio_device_yes";
    const isOutput  = item.coreaudio_device_output === "spaudio_device_yes";
    const isDefIn   = item.coreaudio_default_audio_input_device  === "spaudio_yes";
    const isDefOut  = item.coreaudio_default_audio_output_device === "spaudio_yes";
    const connection = classifyDarwinTransport(item.coreaudio_device_transport, name);
    const transport  = item.coreaudio_device_transport;

    if (isInput) {
      inputDevices.push({ name, kind: "input", connection, isDefault: isDefIn, ...(transport && { transport }) });
      if (isDefIn && !defaultInput) defaultInput = name;
    }
    if (isOutput) {
      outputDevices.push({ name, kind: "output", connection, isDefault: isDefOut, ...(transport && { transport }) });
      if (isDefOut && !defaultOutput) defaultOutput = name;
    }
  }

  return {
    platform:      "darwin",
    inputDevices,
    outputDevices,
    defaultInput,
    defaultOutput,
  };
}

async function listAudioDarwin(): Promise<ListAudioDevicesResult> {
  const { stdout } = await execAsync(
    "system_profiler SPAudioDataType -json 2>/dev/null",
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return parseDarwinOutput(stdout);
}

// -- win32 implementation -----------------------------------------------------

interface WinAudioDevice {
  Name:       string;      // e.g. "Microphone (Realtek)"
  Class:      string;      // "AudioEndpoint"
  Status:     string;      // "OK" | "Error" etc.
  FriendlyName?: string;
  InstanceId?:   string;
}

interface WinDefaults {
  defaultInput?:  string;
  defaultOutput?: string;
}

function classifyWinConnection(instanceId: string | undefined, name: string): AudioDevice["connection"] {
  const id = (instanceId ?? "").toUpperCase();
  const n  = name.toLowerCase();
  if (id.includes("USB"))                  return "usb";
  if (id.includes("BTHENUM") || n.includes("bluetooth") || n.includes("airpods")) {
    return "bluetooth";
  }
  if (id.includes("HDAUDIO") || id.includes("INTELAUDIO")) return "built-in";
  if (id.includes("HDMI"))                 return "hdmi";
  return "unknown";
}

function parseWinOutput(rawDevices: string, rawDefaults: string): ListAudioDevicesResult {
  const devicesParsed = rawDevices.trim()
    ? (JSON.parse(rawDevices) as WinAudioDevice | WinAudioDevice[])
    : [];
  const devices: WinAudioDevice[] = Array.isArray(devicesParsed)
    ? devicesParsed
    : [devicesParsed];

  const defaults: WinDefaults = rawDefaults.trim()
    ? (JSON.parse(rawDefaults) as WinDefaults)
    : {};

  const inputDevices:  AudioDevice[] = [];
  const outputDevices: AudioDevice[] = [];

  for (const d of devices) {
    if (!d?.Name) continue;
    const connection = classifyWinConnection(d.InstanceId, d.Name);
    const transport  = d.InstanceId;
    const nameLower  = d.Name.toLowerCase();

    // Get-PnpDevice -Class AudioEndpoint returns both render (output) and
    // capture (input) endpoints.  The InstanceId prefix discriminates them:
    //   SWD\MMDEVAPI\{0.0.0.00000000}...  → render
    //   SWD\MMDEVAPI\{0.0.1.00000000}...  → capture
    const isCapture  = (d.InstanceId ?? "").includes("{0.0.1.00000000}");
    const isRender   = (d.InstanceId ?? "").includes("{0.0.0.00000000}");

    // Fallback if the InstanceId format is unexpected — use the device
    // name heuristic.
    const kind: "input" | "output" =
      isCapture ? "input"
      : isRender ? "output"
      : (nameLower.includes("microphone") || nameLower.includes("mic")
          ? "input"
          : "output");

    const isDefault = kind === "input"
      ? defaults.defaultInput  === d.Name
      : defaults.defaultOutput === d.Name;

    const device: AudioDevice = {
      name: d.Name,
      kind,
      connection,
      isDefault,
      ...(transport && { transport }),
    };

    if (kind === "input")  inputDevices.push(device);
    else                   outputDevices.push(device);
  }

  return {
    platform:      "win32",
    inputDevices,
    outputDevices,
    defaultInput:  defaults.defaultInput  ?? null,
    defaultOutput: defaults.defaultOutput ?? null,
  };
}

async function listAudioWin32(): Promise<ListAudioDevicesResult> {
  const devicesScript = `
$ErrorActionPreference = 'SilentlyContinue'
Get-PnpDevice -Class AudioEndpoint | Select-Object Name, Class, Status, FriendlyName, InstanceId | ConvertTo-Json -Depth 2 -Compress`.trim();

  // Default-device probe: use the MMDevice COM wrapper via audio-policy
  // queries.  When this fails (Server Core, restricted Windows SKUs),
  // the fallback leaves the default fields null — device enumeration
  // still succeeds.
  const defaultsScript = `
$ErrorActionPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName PresentationCore
  $defInput  = (Get-CimInstance Win32_SoundDevice -Filter "Status='OK'" | Where-Object { $_.Name -match 'Microphone|Input' } | Select-Object -First 1).Name
  $defOutput = (Get-CimInstance Win32_SoundDevice -Filter "Status='OK'" | Where-Object { $_.Name -notmatch 'Microphone|Input' } | Select-Object -First 1).Name
  [pscustomobject]@{ defaultInput = $defInput; defaultOutput = $defOutput } | ConvertTo-Json -Compress
} catch {
  '{}'
}`.trim();

  const [rawDevices, rawDefaults] = await Promise.all([
    runPS(devicesScript),
    runPS(defaultsScript),
  ]);

  return parseWinOutput(rawDevices, rawDefaults);
}

// -- Exported run function ----------------------------------------------------

export async function run(): Promise<ListAudioDevicesResult> {
  const platform = os.platform();
  if (platform === "darwin") return listAudioDarwin();
  if (platform === "win32")  return listAudioWin32();
  throw new Error(`list_audio_devices: unsupported platform "${platform}"`);
}

// -- Test helpers -------------------------------------------------------------

/** Exported for unit tests only — do not use from production code. */
export const __testing = {
  parseDarwinOutput,
  parseWinOutput,
  classifyDarwinTransport,
  classifyWinConnection,
};
