# Teams / Slack / Zoom / Webex problem

**Skill:** `collab-app-repair` · **Risk:** medium · **Steps:** 11

Diagnoses and repairs Microsoft Teams, Slack, Zoom, and Cisco Webex problems including media issues (mic, camera, speaker), stuck cache, stale meeting metadata, and search-index failures. Preserves the user's signed-in state — clears app cache and resets A/V device selection without forcing the user to sign back in.

## What it does, step by step

**Step 1.** Detects which collab apps are installed and whether the user is currently signed in.
_read-only_ · `check_collab_app_status`

**Step 1b.** Asks the user to sign in first, since that alone may resolve the reported problem.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Lists available microphones and speakers so the user can confirm the right device is present.
_read-only_ · `list_audio_devices`

**Step 2b.** Lists available cameras so the user can confirm the right device is present.
_read-only_ · `list_video_devices`

**Step 3.** Checks whether the app has the microphone, camera, or screen-recording permission it needs.
_read-only_ · `check_app_permissions`

**Step 3b.** Asks the user to grant the missing permission and confirm whether that fixes the issue.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Resets the app's audio and video device selection back to the correct devices.
_deletes data, asks permission, preview first_ · `reset_av_device_selection`

**Step 5.** Clears the app's cache to fix stale search, messages, or meeting data while staying signed in.
_deletes data, asks permission, preview first_ · `clear_collab_app_cache`

**Step 6.** Restarts the app so the cleared cache and device settings take effect.
_deletes data, asks permission_ · `restart_process`

**Step 7.** Asks the user to retest the app and reports whether the problem is resolved.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Summarizes what was checked and changed, and recommends escalation if the problem remains.
_no tools_

## Tools it may use

`check_collab_app_status`, `list_audio_devices`, `list_video_devices`, `clear_collab_app_cache`, `reset_av_device_selection`, `restart_process`, `check_app_permissions`, `wait_for_user_ack`
