# External display, USB, or Bluetooth peripheral problem

**Skill:** `av-peripheral-repair` · **Risk:** medium · **Steps:** 8

Diagnoses and repairs A/V and peripheral hardware problems including external monitors not detected, AirPods or Bluetooth audio dropping, USB hubs and docks not enumerating, USB-C peripherals losing power, and microphones / cameras not appearing in collab apps. Read-only enumeration where possible; only the Bluetooth-module reset is mutating and gated by G4 dry-run + consent.

## What it does, step by step

**Step 1.** Determines which peripheral type is affected and routes to the matching diagnostic path.
_no tools_

**Step 2.** Checks connected USB devices and flags missing, errored, or underpowered ones.
_read-only_ · `list_usb_devices`

**Step 3.** Checks paired Bluetooth devices and flags radios that are off or peripherals paired but offline.
_read-only_ · `list_bluetooth_devices`

**Step 4.** Checks audio device settings and flags mis-selected or duplicated default devices.
_read-only_ · `list_audio_devices`

**Step 5.** Checks camera detection and flags devices missing, unselected, or blocked by network/range issues.
_read-only_ · `list_video_devices`

**Step 6.** Resets the Bluetooth module as a last resort, with preview and user consent required first.
_deletes data, asks permission, preview first_ · `reset_bluetooth_module`, `list_bluetooth_devices`

**Step 7.** Asks the user to retest the peripheral and records whether the fix worked.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Reports what was diagnosed, what was tried, and whether the issue is resolved or needs escalation.
_no tools_

## Tools it may use

`list_audio_devices`, `list_video_devices`, `list_usb_devices`, `list_bluetooth_devices`, `reset_bluetooth_module`, `wait_for_user_ack`
