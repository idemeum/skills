# Fix a USB device that isn't working

**Skill:** `usb-device-repair` · **Risk:** medium · **Steps:** 8

Diagnoses and fixes USB peripherals that are not detected or not usable.

## What it does, step by step

**Step 1.** Records which USB devices the computer currently recognizes before making changes.
_read-only_ · `list_usb_devices`

**Step 2.** Asks what type of USB device is having trouble.
_asks the user_ · `wait_for_user_ack`

**Step 3.** Asks the user to reconnect the device to a different direct port or cable.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Rechecks connected devices to see if the reconnection fixed the problem.
_read-only_ · `list_usb_devices`

**Step 5.** Checks whether a problem audio device is actually recognized by the system.
_read-only_ · `list_audio_devices`

**Step 6.** Checks whether a problem camera is actually recognized by the system.
_read-only_ · `list_video_devices`

**Step 7.** Clears saved device selections in common meeting apps so they detect the device again.
_makes a change, asks permission, preview first_ · `reset_av_device_selection`

**Step 8.** Confirms whether the device now works or reports that it still needs hardware attention.
_read-only_ · `list_usb_devices`

## Tools it may use

`list_usb_devices`, `wait_for_user_ack`, `list_audio_devices`, `list_video_devices`, `reset_av_device_selection`
