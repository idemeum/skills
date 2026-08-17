# OneDrive / iCloud / Dropbox / Time Machine sync or backup problem

**Skill:** `cloud-sync-backup-repair` · **Risk:** medium · **Steps:** 10

Diagnoses and repairs cloud sync (OneDrive, iCloud Drive, Google Drive, Dropbox) and Time Machine backup problems including stuck queues, stale sync state, missed backups, sync conflicts on slow networks, and credential / token expiry. Read-only probes by default; the only mutating tool is `pause_resume_cloud_sync` and it is reversible.

## What it does, step by step

**Step 1.** Checks each cloud sync app and Time Machine to find the last backup or sync time and whether it looks stuck.
_read-only_ · `check_cloud_sync_status`

**Step 2.** Figures out which sync service or Time Machine the user is asking about.
_read-only_ · `check_cloud_sync_status`

**Step 3.** Checks whether the device can reach the cloud service before troubleshooting further.
_read-only_ · `check_connectivity`

**Step 4.** Decides what's wrong with syncing based on its current status and picks the next action.
_read-only_ · `check_cloud_sync_status`

**Step 5.** Pauses the chosen sync app to help clear a stuck sync state.
_makes a change, asks permission, preview first_ · `pause_resume_cloud_sync`

**Step 5b.** Asks the user to confirm when to resume syncing after the pause.
_asks the user_ · `wait_for_user_ack`

**Step 6.** Resumes syncing for the chosen app once the user confirms.
_makes a change, asks permission, preview first_ · `pause_resume_cloud_sync`

**Step 7.** Checks Time Machine backup status on Mac and explains what's wrong if it's overdue or failed.
_asks the user_ · `check_timemachine_status`, `wait_for_user_ack`

**Step 8.** Rechecks sync status after resuming to confirm the fix worked.
_read-only_ · `check_cloud_sync_status`

**Step 9.** Summarizes findings, actions taken, and next steps, flagging issues that need IT attention.
_no tools_

## Tools it may use

`check_cloud_sync_status`, `pause_resume_cloud_sync`, `check_timemachine_status`, `check_connectivity`, `wait_for_user_ack`
