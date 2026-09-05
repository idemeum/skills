---
name: usb-device-repair
description: Diagnoses and fixes USB peripherals that are not detected or not usable. Use when the user reports a USB device, dock, hub, headset, webcam, keyboard, mouse, or external drive is unrecognized or unresponsive.
allowed-tools:
  - list_usb_devices
  - wait_for_user_ack
  - list_audio_devices
  - list_video_devices
  - reset_av_device_selection
metadata:
  prerequisites:
    before-corrective:
      - list_usb_devices
  maxAggregateRisk: medium
  userLabel: "Fix a USB device that isn't working"
  pill:
    label: Fix USB devices
    goal: My USB connected device is not working, diagnose and fix.
    icon: Cable
    iconClass: text-fuchsia-500
    order: 14
  examples:
    - "my usb headset isn't working"
    - "mac doesn't recognize my external hard drive"
    - "nothing on my dock works when I plug it in"
    - "usb device not recognized"
    - "my webcam stopped showing up after I plugged it in"
    - "usb ports dead after I woke my laptop"
---

## When to use

Use when a USB peripheral is missing from the system, enumerates in an error state, or enumerates but cannot be used. For a Bluetooth peripheral, use `bluetooth-device-repair` instead.

## Steps

**Step 1 — Capture USB baseline**

Call `list_usb_devices`.

**Step 2 — Classify the affected device**

Call `wait_for_user_ack` with:

```yaml
prompt: "Which kind of USB device isn't working?"
options:
  - id: "audio"
    label: "Audio device (headset, microphone, or speakers)"
    kind: "primary"
  - id: "camera"
    label: "Camera (webcam or capture device)"
    kind: "primary"
  - id: "storage"
    label: "Storage (external drive or flash drive)"
    kind: "primary"
  - id: "other"
    label: "Other (keyboard, mouse, dock, or hub)"
    kind: "primary"
```

`Condition:` only run after Step 1 returned a `devices[]` array.

**Step 3 — Re-seat the connection**

Call `wait_for_user_ack` with:

```yaml
prompt: "Unplug the device and plug it into a different port directly on the computer, not through a hub or dock. Try a different cable if you have one. Tell me when you're done."
options:
  - id: "reseated"
    label: "Done (different port and connection)"
    kind: "primary"
  - id: "no-other-port"
    label: "No other port available"
    kind: "primary"
  - id: "skip"
    label: "Can't do this right now"
    kind: "primary"
```

`Condition:` only run after Step 2 returned a `choice`.

Note: re-seating into a directly attached port separates a dead cable, port, or hub from a software fault.

**Step 4 — Re-enumerate and compare**

Call `list_usb_devices`.

`Condition:` only run when Step 3 returned `choice: "reseated"`.

Note: compare `devices[]` against the Step 1 baseline. If the device is now present, or its `status` moved from `error` to `ok`, the original port, cable, or hub was the fault. End the run here, report the faulty port, cable, or hub, and do not run the remaining steps.

**Step 5 — Confirm audio devices reached the OS**

Call `list_audio_devices`.

`Condition:` only run when Step 2 returned `choice: "audio"`.

Note: look for a `connection: "usb"` entry in `inputDevices` and `outputDevices`. A device listed by `list_usb_devices` but missing from both arrays did not load its audio class driver. One that appears in an array but does not match `defaultInput` or `defaultOutput` loaded fine — the OS just never switched to it.

**Step 6 — Confirm the camera reached the OS**

Call `list_video_devices`.

`Condition:` only run when Step 2 returned `choice: "camera"`.

Note: look for a `connection: "usb"` entry in `cameras[]`. A device listed by `list_usb_devices` but missing from that array did not attach its video class driver.

**Step 7 — Clear saved device selections in collaboration apps**

Call `reset_av_device_selection` with `apps: ["teams", "slack", "zoom", "webex"]`.

`Condition:` only run when Step 2 returned `choice: "audio"`, and Step 4 either did not run or did not show the device back at `status: "ok"`.

Note: an app that is not installed returns entries in `errors[]`, which is expected.

**Step 8 — Verify**

Call `list_usb_devices`.

Note: success is the device present with `status: "ok"`. A cleared app selection cannot be confirmed until that app relaunches, so report it as applied rather than verified. Still absent means the cable, the port, or the device itself is dead — escalate to hardware replacement.

## Edge cases

- **`choice` of `timeout`, `cancel`, or `failed` in Step 2** — the device class is unknown, so Steps 5 and 6 both skip and nothing verifies the class. Report on every device whose `status` is not `ok` instead.
- **Device enumerates but will not mount** — an external drive with `status: "ok"` that never appears in the file manager is a filesystem fault, not a USB fault. No tool here checks mounting. End the run.
- **High `busPowerMa` behind an unpowered hub** — the device browns out and re-enumerates in a loop, appearing and disappearing between Step 1 and Step 4. Needs a powered hub, not a software fix.
- **`choice: "no-other-port"` or `"skip"` in Step 3** — the physical layer stays unproven. The software checks still run, but do not report a cable or port fault as ruled out.
- **Class is `storage` or `other`** — Steps 5, 6, and 7 all skip, leaving no corrective action. The run ends at Step 4 with enumeration evidence only.
