---
name: av-peripheral-repair
description: Diagnoses and repairs A/V and peripheral hardware problems including external monitors not detected, AirPods or Bluetooth audio dropping, USB hubs and docks not enumerating, USB-C peripherals losing power, and microphones / cameras not appearing in collab apps. Read-only enumeration where possible; only the Bluetooth-module reset is mutating and gated by G4 dry-run + consent.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - list_audio_devices
  - list_video_devices
  - list_usb_devices
  - list_bluetooth_devices
  - reset_bluetooth_module
metadata:
  prerequisites:
    before-corrective:
      - list_audio_devices
      - list_video_devices
      - list_usb_devices
      - list_bluetooth_devices
  maxAggregateRisk: medium
  userLabel: "External display, USB, or Bluetooth peripheral problem"
  examples:
    - "external monitor isn't showing"
    - "AirPods keep disconnecting"
    - "my dock stopped working after sleep"
    - "USB-C hub has no power"
    - "Bluetooth keyboard not connecting"
    - "my webcam isn't detected"
  pill:
    label: Fix Peripherals
    goal: My external monitor, USB hub, dock, Bluetooth headphones, or other peripheral has stopped working — please diagnose and fix it
    icon: Cable
    iconClass: text-fuchsia-500
    order: 13
---

## When to use

Use this skill when the user:
- Reports an external monitor or display does not show up
- Says AirPods / Bluetooth headphones keep disconnecting or won't pair
- Reports a USB-C hub or dock has stopped working (especially after sleep / wake)
- Says a USB peripheral (webcam, mic, drive) is not detected
- Reports a Bluetooth keyboard, trackpad, or mouse that worked yesterday is not connecting
- Asks "why isn't my monitor / dock / AirPods / mouse working?"

Do NOT use this skill when the symptom is collab-app-specific — e.g. "Zoom can't see my mic but other apps can" — use [collab-app-repair](../collab-app-repair/SKILL.md) instead. Cross-app A/V symptoms (the OS doesn't see the device at all) belong here.

---

## Steps

**Step 1 — Identify the device class the user is reporting**

The skill branches on what kind of peripheral is failing:

| User report | Device class | Continue at |
|---|---|---|
| External display, USB hub, dock, USB drive, USB camera | USB / wired | Step 2 |
| AirPods, Bluetooth keyboard / mouse / headset | Bluetooth | Step 3 |
| Audio device showing up but wrong (mic / speaker selection) | Audio routing | Step 4 |
| Webcam not detected by any app | Video routing | Step 5 |

If the user's report is unclear, run Steps 2 + 3 in parallel — both probes are read-only and cheap.

**Step 2 — Enumerate USB devices**

Call `list_usb_devices`. The result includes vendor/product IDs, manufacturer, and a per-device `status` field (`"ok" | "error" | "unknown"`). Look for:
- A device the user expects (asked to confirm by name) that is NOT in the list → not enumerated, likely a hardware or cable issue
- A device with `status: "error"` → driver or power problem
- USB hubs / docks with very few children → the hub might be enumerated but its downstream ports are not, indicating a power-delivery issue

If the missing device is not in the list at all, advise:
- Try a different cable / USB port (USB-C cables that look identical can be wildly different — e.g. charging-only vs full data)
- For USB-C hubs / docks: the host port must be a "full" USB-C port (Thunderbolt or USB 3.x with Power Delivery). Some MacBook ports and many laptop ports are USB 2.0 only — the hub will appear partially-working
- Power-cycle the dock (unplug from host, count to 10, replug)

**Step 3 — Enumerate Bluetooth devices**

Call `list_bluetooth_devices`. The result reports per-device:
- `connected: true | false` — paired AND currently connected vs paired-but-offline
- `paired: true | false` — paired with the controller
- `batteryPercent` — when reported (macOS surfaces this for AirPods + Magic Keyboard / Trackpad)
- `poweredOn: true | false` — top-level controller state

If the controller is `poweredOn: false`, the Bluetooth radio is off — guide the user to the menu bar (macOS) or Quick Settings (Windows) to toggle it on. Do not run Step 6 in this case.

If a device the user expects is present with `connected: false`, it is paired but offline. Most often the device is asleep (AirPods in case, keyboard powered off) — guide the user to:
1. Wake / power on the device
2. Check battery level (replace batteries if a flashing-low indicator is on)
3. If still offline, unpair + re-pair via the OS UI

**Step 4 — Audio routing problems**

Call `list_audio_devices`. The result enumerates input + output devices and flags the system default. Common patterns:
- The expected device IS listed but is not the default → a setting issue, not a hardware issue. The user can change the default via System Settings → Sound (macOS) or Settings → System → Sound (Windows). For per-app overrides, use [collab-app-repair](../collab-app-repair/SKILL.md)
- The expected device is NOT listed → physical connection problem. If it is a USB device, return to Step 2; if Bluetooth, return to Step 3
- Multiple of the same device appear (e.g. two "AirPods Pro") → an OS pairing artifact; advise the user to unpair both then re-pair the active one

**Step 5 — Video / camera routing problems**

Call `list_video_devices`. Symptoms:
- Camera not in list → return to Step 2 (most webcams are USB) or Step 3 (Continuity Camera over Bluetooth proximity)
- Camera in list but not selected by an app → app-specific configuration; route to [collab-app-repair](../collab-app-repair/SKILL.md)
- macOS Continuity Camera (iPhone-as-webcam) reports `connection: "continuity"` but does not appear in apps → the iPhone may be off-Wi-Fi or out of Bluetooth range; advise the user to put both devices on the same network and within a few feet

**Step 6 — Reset the Bluetooth module (last resort)**

Run this step only when:
- The user has confirmed the Bluetooth controller is powered on (Step 3 output)
- A specific paired device is listed as `connected: false` and waking / re-pairing has not helped
- The user accepts that all currently-active Bluetooth connections (audio call, input devices) will drop briefly

Call `reset_bluetooth_module`. The G4 dry-run gate surfaces the exact command (`launchctl kickstart` on macOS, `Restart-Service bthserv` on Windows) and warns about the brief connection drop. After consent, the tool runs the restart. Active connections re-establish automatically within 2–5 seconds.

This tool requires admin privilege — `affectedScope: ["system"]` triggers the G4 scope-boundary check. If the agent is running without admin, the step is aborted by G4 and the run cleanly ends. Advise the user to escalate to IT in that case.

After the reset, call `list_bluetooth_devices` again to verify the previously-disconnected device is now `connected: true`.

**Step 7 — Final report**

Summarise:
- Which peripheral was diagnosed and what class (USB / Bluetooth / audio routing / video routing)
- What the OS sees vs what the user expects
- Which physical actions (cable swap, port change, power-cycle dock, replace batteries) the user should try
- Whether the Bluetooth module was reset

If the symptom persists after Steps 2–6, the likely remaining causes are hardware failure or an OS-level driver corruption that needs IT intervention. Escalate.

---

## Edge cases

- **External display via Thunderbolt / DisplayPort over USB-C** — USB enumeration alone won't surface the display. macOS reports DP-over-USB-C in `system_profiler SPDisplaysDataType` (a separate tool); Windows reports it under the Monitor PnP class. The current toolset does not enumerate displays directly — if the user reports a missing display, Step 2's USB output may show the **dock** but not the display. Advise the user to verify the display works on a different machine (rule out display hardware) before escalating
- **USB-C cable confusion** — many USB-C cables that look identical only carry power, not data. If a USB-C peripheral isn't enumerating, the cable is the most common cause. Ask the user to try a different cable before any further diagnosis
- **Continuity Camera** — appears under `list_video_devices` with `connection: "continuity"` only when the iPhone is unlocked, on the same Wi-Fi network as the Mac, and within Bluetooth proximity. If the iPhone is locked or out of range the camera silently disappears from the list. Brief the user on these requirements before flagging it as missing
- **Bluetooth audio + Bluetooth input simultaneously** — restarting the Bluetooth module drops the user's keyboard / trackpad / mouse for 2–5 seconds. If the user is on a laptop with NO built-in trackpad / wired mouse, they will be locked out of input during that window. Advise the user to have a wired alternative on hand or to use a built-in trackpad before consenting to the reset
- **Tamper-protected MDM-managed Bluetooth** — some MDM profiles disable user-side Bluetooth toggling. The agent's `reset_bluetooth_module` may fail with a permission error even when run as admin; surface this as IT-managed restriction and escalate
- **macOS coreaudiod and Bluetooth audio quirks** — sometimes Bluetooth audio shows up in `list_audio_devices` but the selected device produces no sound. The fix in that case is to restart `coreaudiod`, NOT the Bluetooth daemon. That is out of scope for this skill — advise the user to restart the Mac as a workaround or escalate to IT
- **Windows USB Selective Suspend** — Windows may have placed a USB hub into selective suspend during sleep, and refuse to wake it. The fix is in Power Options → USB selective suspend = Disabled. The current toolset does not toggle this; surface as a setting the user (or IT) needs to change
- **Apple Silicon vs Intel Bluetooth chips** — Apple Silicon Macs use a different Bluetooth chipset. Some legacy peripherals (older keyboards, older car infotainment systems) have known compatibility issues. If a user reports a long-paired device suddenly unreliable after a Mac upgrade, the chipset change may be the root cause; escalate to IT or to the peripheral vendor
