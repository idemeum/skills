# Install an app, or reinstall a broken one

**Skill:** `software-reinstall` · **Risk:** high · **Steps:** 18

Installs an application the user does not have, and repairs one that is broken by reinstalling it cleanly. Covers Self Service catalog install on managed devices, signature verification, thorough uninstallation, installer download with checksum validation, and silent installation.

## What it does, step by step

**Step 1.** Checks whether the application is already installed and reports its version and location.
_read-only_ · `list_installed_apps`

**Step 2.** Verifies the app's code signature to determine if it's corrupted or intact.
_read-only_ · `check_app_integrity`

**Step 3.** Checks whether the app has all required system permissions and flags any missing ones.
_read-only_ · `check_app_permissions`

**Step 4.** Determines whether the device is managed by MDM to decide the best install route.
_read-only_ · `check_mdm_enrollment`

**Step 4b.** Asks the user whether to try non-destructive fixes first or go straight to a clean reinstall.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Resets the app's preferences after confirming the change with the user, keeping other data intact.
_deletes data, asks permission, preview first_ · `reset_app_preferences`

**Step 5b.** Clears the app's cache to help resolve misbehavior without affecting user data.
_makes a change, preview first_ · `clear_app_cache`

**Step 6.** Asks the user to test the app and reports whether the non-destructive fixes resolved the issue.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Checks which managed app catalog is available on the device and looks up the app there.
_read-only_ · `query_self_service_catalog`

**Step 8.** Opens the managed app catalog directly to the app's install screen for the user.
_read-only_ · `trigger_self_service_install`

**Step 9.** Asks the user to complete the catalog install and reports the outcome.
_asks the user_ · `wait_for_user_ack`

**Step 10.** Removes the existing app and all its related files after user confirmation, for a clean reinstall.
_deletes data, asks permission, preview first_ · `uninstall_app`

**Step 11.** Asks the user for the official vendor download link and checksum for the app.
_asks the user_ · `request_user_input`

**Step 12.** Downloads the installer from the provided link and validates its integrity.
_read-only_ · `download_installer`

**Step 13.** Runs the installer after user confirmation to install the app silently.
_makes a change, asks permission, preview first, conditional_ · `run_installer`

**Step 14.** Confirms the newly installed app version is registered on the device.
_read-only_ · `list_installed_apps`

**Step 15.** Asks the user to grant needed permissions and confirm the app now launches correctly.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Reports what caused the issue, how it was fixed, and any remaining steps for the user.
_no tools_

## Tools it may use

`list_installed_apps`, `check_app_integrity`, `check_app_permissions`, `check_mdm_enrollment`, `query_self_service_catalog`, `trigger_self_service_install`, `uninstall_app`, `download_installer`, `run_installer`, `reset_app_preferences`, `clear_app_cache`, `wait_for_user_ack`, `request_user_input`
