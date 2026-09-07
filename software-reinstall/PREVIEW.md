# Install an app, or reinstall a broken one

**Skill:** `software-reinstall` · **Risk:** high · **Steps:** 16

Installs an application the user does not have, and repairs one that is broken by reinstalling it cleanly. Covers Self Service catalog install on managed devices, signature verification, thorough uninstallation, installer download with checksum validation, and silent installation.

## What it does, step by step

**Step 1.** Checks whether the app is installed, intact, corrupt, or missing key permissions.
_read-only_ · `survey_app`

**Step 2.** Determines whether the device is enrolled in management to decide the best install route.
_read-only_ · `check_mdm_enrollment`

**Step 2b.** Asks the user to choose between trying non-destructive fixes or reinstalling right away.
_asks the user_ · `wait_for_user_ack`

**Step 3.** Resets the app's saved preferences after confirming the user wants to try a non-destructive fix.
_deletes data, asks permission, preview first_ · `reset_app_preferences`

**Step 3b.** Clears the app's cached data as part of the non-destructive fix attempt.
_makes a change, preview first_ · `clear_app_cache`

**Step 4.** Asks the user to test the app and reports whether the non-destructive fixes worked.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Checks which managed software catalog is available and whether the app can be found in it.
_read-only_ · `query_self_service_catalog`

**Step 6.** Opens the managed software catalog directly to the app's install screen for the user.
_read-only_ · `trigger_self_service_install`

**Step 7.** Asks the user to complete the catalog install and reports whether it succeeded.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Removes the existing app and all its related files for a clean reinstall.
_deletes data, asks permission, preview first_ · `uninstall_app`

**Step 9.** Asks the user for the official vendor download link and checksum for the app.
_asks the user_ · `request_user_input`

**Step 10.** Downloads the installer from the provided vendor link and verifies its integrity.
_read-only_ · `download_installer`

**Step 11.** Runs the downloaded installer silently to install the app cleanly.
_makes a change, asks permission, preview first, conditional_ · `run_installer`

**Step 12.** Confirms the newly installed app now appears in the system's list of installed software.
_read-only_ · `list_installed_apps`

**Step 13.** Asks the user to re-grant needed permissions and confirm the app now launches properly.
_asks the user_ · `wait_for_user_ack`

**Step 14.** Summarizes what was wrong, how it was fixed, and any remaining follow-up for the user.
_no tools_

## Tools it may use

`survey_app`, `list_installed_apps`, `check_mdm_enrollment`, `query_self_service_catalog`, `trigger_self_service_install`, `uninstall_app`, `download_installer`, `run_installer`, `reset_app_preferences`, `clear_app_cache`, `wait_for_user_ack`, `request_user_input`
