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
  - wait_for_user_ack
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
    order: 12
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

`Condition:` only run if Step 1 routed to USB / wired (external display, USB hub, dock, USB drive, USB camera) OR the user's symptom is unclear (in which case Steps 2 and 3 run in parallel).

Call `list_usb_devices`. The result includes vendor/product IDs, manufacturer, and a per-device `status` field (`"ok" | "error" | "unknown"`). Look for:
- A device the user expects that is NOT in the list → not enumerated, likely a hardware or cable issue
- A device with `status: "error"` → driver or power problem
- USB hubs / docks with very few children → the hub might be enumerated but its downstream ports are not, indicating a power-delivery issue

If the missing device is not in the list at all, advise (Step 7's final-test ack will verify whether these worked):
- Try a different cable / USB port (USB-C cables that look identical can be wildly different — e.g. charging-only vs full data)
- For USB-C hubs / docks: the host port must be a "full" USB-C port (Thunderbolt or USB 3.x with Power Delivery). Some MacBook ports and many laptop ports are USB 2.0 only — the hub will appear partially-working
- Power-cycle the dock (unplug from host, count to 10, replug)

**Step 3 — Enumerate Bluetooth devices**

`Condition:` only run if Step 1 routed to Bluetooth (AirPods, Bluetooth keyboard / mouse / headset) OR the user's symptom is unclear (parallel-fire with Step 2).

Call `list_bluetooth_devices`. The result reports per-device:
- `connected: true | false` — paired AND currently connected vs paired-but-offline
- `paired: true | false` — paired with the controller
- `batteryPercent` — when reported (macOS surfaces this for AirPods + Magic Keyboard / Trackpad)
- `poweredOn: true | false` — top-level controller state

If the controller is `poweredOn: false`, the Bluetooth radio is off — guide the user to the menu bar (macOS) or Quick Settings (Windows) to toggle it on. Do NOT proceed to Step 6 in this case (the reset is pointless against a powered-off radio).

If a device the user expects is present with `connected: false`, it is paired but offline. Most often the device is asleep (AirPods in case, keyboard powered off) — guide the user to:
1. Wake / power on the device
2. Check battery level (replace batteries if a flashing-low indicator is on)
3. If still offline, unpair + re-pair via the OS UI

Step 7's final-test ack will verify whether these worked.

**Step 4 — Audio routing problems**

`Condition:` only run if Step 1 routed to audio routing (audio device showing up but wrong — wrong mic / speaker default selection). Note: the OS-doesn't-see-the-device case for audio routes to Step 2 (USB audio device) or Step 3 (Bluetooth audio device) instead.

Call `list_audio_devices`. The result enumerates input + output devices and flags the system default. Common patterns:
- The expected device IS listed but is not the default → a setting issue, not a hardware issue. The user can change the default via System Settings → Sound (macOS) or Settings → System → Sound (Windows). For per-app overrides, use [collab-app-repair](../collab-app-repair/SKILL.md)
- The expected device is NOT listed → physical connection problem. If it is a USB device, return to Step 2; if Bluetooth, return to Step 3
- Multiple of the same device appear (e.g. two "AirPods Pro") → an OS pairing artifact; advise the user to unpair both then re-pair the active one

**Step 5 — Video / camera routing problems**

`Condition:` only run if Step 1 routed to video (webcam not detected by any app).

Call `list_video_devices`. Symptoms:
- Camera not in list → return to Step 2 (most webcams are USB) or Step 3 (Continuity Camera over Bluetooth proximity)
- Camera in list but not selected by an app → app-specific configuration; route to [collab-app-repair](../collab-app-repair/SKILL.md)
- macOS Continuity Camera (iPhone-as-webcam) reports `connection: "continuity"` but does not appear in apps → the iPhone may be off-Wi-Fi or out of Bluetooth range; advise the user to put both devices on the same network and within a few feet

**Step 6 — Reset the Bluetooth module (last resort)**

`Condition:` only run when ALL of the following hold:
- Step 3's `list_bluetooth_devices` returned `poweredOn: true` (the radio is on; a reset against a powered-off radio is pointless)
- Step 3 returned at least one paired device with `connected: false` (something to reconnect)
- The user has confirmed acceptance of a brief 2–5s disruption to active Bluetooth connections (laptop users without a wired or built-in alternative input device should NOT consent — they'll be locked out during the window; see Edge cases)

Call `reset_bluetooth_module`. G4 fires the consent gate automatically (`requiresConsent: true`) with the dry-run preview surfaced inside (`supportsDryRun: true`) — the user sees the exact command (`launchctl kickstart` on macOS, `Restart-Service bthserv` on Windows) and the brief-connection-drop warning before approving. Active connections re-establish automatically within 2–5 seconds.

This tool requires admin privilege — `affectedScope: ["system"]` triggers the G4 scope-boundary check. The privileged helper daemon (default `HELPER_DAEMON_ENABLED=true`) routes it transparently for non-admin users. If the helper is unavailable or the call is denied, the step aborts cleanly; surface IT-escalation advice in Step 8.

After the reset, re-call `list_bluetooth_devices` to verify the previously-disconnected device is now `connected: true` (this inline verification feeds Step 7's ack and Step 8's final report).

**Step 7 — Wait for user to test the peripheral**

`Condition:` only run if any of Steps 2–6 surfaced corrective advice OR Step 6's `reset_bluetooth_module` ran. Skip when Steps 2–5 returned cleanly with no advice (rare — usually means the user's report doesn't match any observable state, in which case Step 8 reports the discrepancy).

Call `wait_for_user_ack`:

```yaml
prompt: "Try the steps I suggested (cable swap, dock power-cycle, wake/power-on the device, replace batteries, re-pair, or trust the Bluetooth reset if it ran) and let me know if your peripheral is working now."
options:
  - { id: "works",        label: "It works now",                kind: "primary" }
  - { id: "still-broken", label: "Still not working",           kind: "secondary" }
  - { id: "skip",         label: "Skip — I'll test later",      kind: "cancel" }
```

On `works`: report success and end the run. On `still-broken`: surface IT-escalation guidance in Step 8 — likely hardware failure (cable, port, peripheral) or driver corruption that requires IT intervention. On `skip`: close with "diagnostics complete; user will verify later".

Without this gate, the skill ends after Step 6's optional reset without ever asking the user whether the recommended physical actions (cable swap / dock cycle / device wake / re-pair) actually fixed the symptom — leaving the agent blind to whether escalation is needed.

**Step 8 — Final report**

Summarise:
- Which peripheral was diagnosed and what class (USB / Bluetooth / audio routing / video routing)
- What the OS sees vs what the user expects
- Which physical actions (cable swap, port change, power-cycle dock, replace batteries) the user tried
- Whether the Bluetooth module was reset
- The user's Step 7 ack outcome (`works` / `still-broken` / `skip`)

If Step 7 returned `still-broken` (or was skipped and Steps 2–6 surfaced no fix), the likely remaining causes are hardware failure or an OS-level driver corruption that needs IT intervention. Escalate with the full diagnostic packet from Steps 2–6.

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
