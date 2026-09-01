# External display, USB, or Bluetooth peripheral problem

**Skill:** `av-peripheral-repair` · **Risk:** medium · **Steps:** 8

Diagnoses and repairs A/V and peripheral hardware problems including external monitors not detected, AirPods or Bluetooth audio dropping, USB hubs and docks not enumerating, USB-C peripherals losing power, and microphones / cameras not appearing in collab apps. Read-only enumeration where possible; only the Bluetooth-module reset is mutating and gated by G4 dry-run + consent.

## What it does, step by step

**Step 1.** Determines which type of peripheral is affected and routes to the matching diagnostic step.
_no tools_

**Step 2.** Checks which USB devices the system currently detects and flags missing or errored ones.
_read-only_ · `list_usb_devices`

**Step 3.** Checks paired Bluetooth devices, their connection state, power, and battery level.
_read-only_ · `list_bluetooth_devices`

**Step 4.** Reviews audio input and output devices to find default-selection or duplicate-pairing issues.
_read-only_ · `list_audio_devices`

**Step 5.** Reviews detected cameras to identify whether the problem is connection- or app-related.
_read-only_ · `list_video_devices`

**Step 6.** Resets the Bluetooth radio, with user consent, to restore paired-but-offline devices.
_makes a change, asks permission, preview first_ · `reset_bluetooth_module`, `list_bluetooth_devices`

**Step 7.** Asks the user to try the suggested fixes and reports whether the peripheral now works.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Summarizes the diagnosis, actions taken, and outcome, escalating to IT if unresolved.
_no tools_

## Tools it may use

`list_audio_devices`, `list_video_devices`, `list_usb_devices`, `list_bluetooth_devices`, `reset_bluetooth_module`, `wait_for_user_ack`
