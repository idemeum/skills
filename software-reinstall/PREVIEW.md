# App crashing or needs reinstall

**Skill:** `software-reinstall` · **Risk:** high · **Steps:** 18

Diagnoses application integrity issues and performs clean software reinstallation. Covers signature verification, thorough uninstallation, installer download with checksum validation, silent installation, and MDM-managed reinstalls.

## What it does, step by step

**Step 1.** Checks whether the app is already installed and notes its version and location.
_read-only_ · `list_installed_apps`

**Step 2.** Verifies the app's code signature is intact to determine if the bundle is corrupted.
_read-only_ · `check_app_integrity`

**Step 3.** Checks whether the app has the system permissions it needs to run properly.
_read-only_ · `check_app_permissions`

**Step 4.** Checks whether the device is managed by MDM to determine the best install route.
_read-only_ · `check_mdm_enrollment`

**Step 4b.** Asks whether to try safe fixes first or go straight to a clean reinstall.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Resets the app's saved preferences as a safe first attempt to fix the problem.
_deletes data, asks permission, preview first_ · `reset_app_preferences`

**Step 5b.** Clears the app's cached data as a safe first attempt to fix the problem.
_makes a change, preview first_ · `clear_app_cache`

**Step 6.** Asks the user to relaunch the app and reports whether the safe fixes resolved it.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Looks up the company's app store to see if the app can be reinstalled through it.
_read-only_ · `query_self_service_catalog`

**Step 8.** Opens the company app store directly to the app's install screen for the user.
_read-only_ · `trigger_self_service_install`

**Step 9.** Asks the user to complete the install through the company app store and reports the outcome.
_asks the user_ · `wait_for_user_ack`

**Step 10.** Removes the app and its leftover files completely to prepare for a clean reinstall.
_deletes data, asks permission, preview first_ · `uninstall_app`

**Step 11.** Asks the user for the official vendor download link for the app.
_asks the user_ · `request_user_input`

**Step 12.** Downloads the installer from the vendor and verifies it hasn't been tampered with.
_read-only_ · `download_installer`

**Step 13.** Runs the downloaded installer to install the app without further prompts.
_deletes data, asks permission, preview first, conditional_ · `run_installer`

**Step 14.** Confirms the newly installed app version is properly registered on the device.
_read-only_ · `list_installed_apps`

**Step 15.** Asks the user to re-grant permissions and confirm the app now opens successfully.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Summarizes the issue found, the fix applied, and any follow-up actions needed.
_no tools_

## Tools it may use

`list_installed_apps`, `check_app_integrity`, `check_app_permissions`, `check_mdm_enrollment`, `query_self_service_catalog`, `trigger_self_service_install`, `uninstall_app`, `download_installer`, `run_installer`, `reset_app_preferences`, `clear_app_cache`, `wait_for_user_ack`, `request_user_input`
