# Install an app, or reinstall a broken one

**Skill:** `software-reinstall` · **Risk:** high · **Steps:** 16

Installs an application the user does not have, and repairs one that is broken by reinstalling it cleanly. Covers Self Service catalog install on managed devices, signature verification, thorough uninstallation, installer download with checksum validation, and silent installation.

## What it does, step by step

**Step 1.** Checks whether the app is installed, whether its files are intact, and what permissions it holds.
_read-only_ · `survey_app`

**Step 2.** Determines whether the device is enrolled in management, deciding whether a catalog install is possible.
_read-only_ · `check_mdm_enrollment`

**Step 2b.** Asks the user whether to try safe fixes first or go straight to a clean reinstall.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 3.** Resets the app's preferences to their defaults after confirming the change with the user.
_deletes data, asks permission, preview first_ · `reset_app_preferences`

**Step 3b.** Clears the app's cached data to help resolve the misbehaving app.
_makes a change, preview first_ · `clear_app_cache`

**Step 4.** Asks the user to relaunch the app and report whether the reset and cache clear fixed it.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Checks which managed software catalog is available on the device and whether the app is listed there.
_read-only_ · `query_self_service_catalog`

**Step 6.** Opens the managed software catalog directly to the app's install screen.
_read-only_ · `trigger_self_service_install`

**Step 7.** Asks the user to complete the catalog install and report whether it succeeded.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Removes the existing app and all its related files after confirming with the user.
_deletes data, asks permission, preview first_ · `uninstall_app`

**Step 9.** Asks the user for the official vendor download link and checksum for the app.
_asks the user_ · `request_user_input`

**Step 10.** Downloads the installer from the vendor link and verifies its integrity.
_read-only_ · `download_installer`

**Step 11.** Runs the downloaded installer after confirming the action with the user.
_makes a change, asks permission, preview first, conditional_ · `run_installer`

**Step 12.** Confirms the newly installed app is registered and shows up on the device.
_read-only_ · `list_installed_apps`

**Step 13.** Asks the user to grant needed permissions and confirm the app now opens correctly.
_asks the user_ · `wait_for_user_ack`

**Step 14.** Summarizes what was wrong, how it was fixed, and any remaining steps for the user.
_no tools_

## Tools it may use

`survey_app`, `list_installed_apps`, `check_mdm_enrollment`, `query_self_service_catalog`, `trigger_self_service_install`, `uninstall_app`, `download_installer`, `run_installer`, `reset_app_preferences`, `clear_app_cache`, `wait_for_user_ack`, `request_user_input`
