# Fix a Bluetooth device that won't connect

**Skill:** `bluetooth-device-repair` · **Risk:** medium · **Steps:** 7

Diagnoses and fixes Bluetooth peripherals that will not connect or that keep dropping out.

## What it does, step by step

**Step 1.** Checks whether Bluetooth is on and lists paired devices with connection, signal, and battery details.
_read-only_ · `list_bluetooth_devices`

**Step 2.** Asks the user to turn Bluetooth on and report whether the device now connects.
_asks the user_ · `wait_for_user_ack`

**Step 3.** Asks the user to charge, restart, and keep the device close, then reports if it connects.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Restarts the Bluetooth service to clear a stuck connection.
_makes a change, asks permission, preview first_ · `reset_bluetooth_module`

**Step 5.** Rechecks Bluetooth devices and their connection status after the restart.
_read-only_ · `list_bluetooth_devices`

**Step 6.** Asks the user to forget and re-pair the device, then reports whether it connects.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Confirms whether the device is now connected or flags it for hardware replacement.
_read-only_ · `list_bluetooth_devices`

## Tools it may use

`list_bluetooth_devices`, `wait_for_user_ack`, `reset_bluetooth_module`
