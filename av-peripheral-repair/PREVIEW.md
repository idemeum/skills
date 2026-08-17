# External display, USB, or Bluetooth peripheral problem

**Skill:** `av-peripheral-repair` · **Risk:** medium · **Steps:** 8

Diagnoses and repairs A/V and peripheral hardware problems including external monitors not detected, AirPods or Bluetooth audio dropping, USB hubs and docks not enumerating, USB-C peripherals losing power, and microphones / cameras not appearing in collab apps. Read-only enumeration where possible; only the Bluetooth-module reset is mutating and gated by G4 dry-run + consent.

## What it does, step by step

**Step 1.** Determines which type of peripheral is affected to route diagnosis appropriately.
_no tools_

**Step 2.** Lists connected USB devices to spot missing, errored, or underpowered hardware.
_read-only_ · `list_usb_devices`

**Step 3.** Lists paired Bluetooth devices to check power, pairing, and connection status.
_read-only_ · `list_bluetooth_devices`

**Step 4.** Checks whether the right audio device is selected as the system default.
_read-only_ · `list_audio_devices`

**Step 5.** Checks whether the camera is detected and properly selected by apps.
_read-only_ · `list_video_devices`

**Step 6.** Restarts the Bluetooth module to reconnect paired devices, with user consent first.
_makes a change, asks permission, preview first_ · `reset_bluetooth_module`, `list_bluetooth_devices`

**Step 7.** Asks the user to test the peripheral and reports whether it now works.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Summarizes the diagnosis, actions taken, and outcome, escalating to IT if unresolved.
_no tools_

## Tools it may use

`list_audio_devices`, `list_video_devices`, `list_usb_devices`, `list_bluetooth_devices`, `reset_bluetooth_module`, `wait_for_user_ack`
