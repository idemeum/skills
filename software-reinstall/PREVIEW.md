# App crashing or needs reinstall

**Skill:** `software-reinstall` · **Risk:** high · **Steps:** 18

Diagnoses application integrity issues and performs clean software reinstallation. Covers signature verification, thorough uninstallation, installer download with checksum validation, silent installation, and MDM-managed reinstalls.

## What it does, step by step

**Step 1.** Checks whether the application is currently installed and identifies its version and location.
_read-only_ · `list_installed_apps`

**Step 2.** Verifies the application's code signature to determine if its files are corrupted.
_read-only_ · `check_app_integrity`

**Step 3.** Checks whether the app has all required system permissions granted.
_read-only_ · `check_app_permissions`

**Step 4.** Checks whether the device is managed by MDM to determine the best install method.
_read-only_ · `check_mdm_enrollment`

**Step 4b.** Asks whether to try safe fixes first or go straight to a clean reinstall.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Resets the app's preferences as a safe first attempt to fix the issue.
_deletes data, asks permission, preview first_ · `reset_app_preferences`

**Step 5b.** Clears the app's cache as a safe first attempt to fix the issue.
_makes a change, preview first_ · `clear_app_cache`

**Step 6.** Asks the user to relaunch the app and report whether the safe fixes worked.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Checks the managed software catalog for an available, supported version of the app.
_read-only_ · `query_self_service_catalog`

**Step 8.** Opens the managed software catalog directly to the app's install screen.
_read-only_ · `trigger_self_service_install`

**Step 9.** Asks the user to complete the install through the managed catalog and report the result.
_asks the user_ · `wait_for_user_ack`

**Step 10.** Removes the existing application and its related files for a clean reinstall.
_deletes data, asks permission, preview first_ · `uninstall_app`

**Step 11.** Asks the user for the official vendor download link and checksum for the app.
_asks the user_ · `request_user_input`

**Step 12.** Downloads the installer from the provided link and verifies its integrity.
_read-only_ · `download_installer`

**Step 13.** Runs the downloaded installer to reinstall the application.
_makes a change, asks permission, preview first, conditional_ · `run_installer`

**Step 14.** Confirms the new installation is registered and recognized by the system.
_read-only_ · `list_installed_apps`

**Step 15.** Asks the user to re-grant permissions and confirm the app now launches correctly.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Summarizes the issue found, the fix applied, and any remaining follow-up actions.
_no tools_

## Tools it may use

`list_installed_apps`, `check_app_integrity`, `check_app_permissions`, `check_mdm_enrollment`, `query_self_service_catalog`, `trigger_self_service_install`, `uninstall_app`, `download_installer`, `run_installer`, `reset_app_preferences`, `clear_app_cache`, `wait_for_user_ack`, `request_user_input`
