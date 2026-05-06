---
name: software-reinstall
description: Diagnoses application integrity issues and performs clean software reinstallation. Covers signature verification, thorough uninstallation, installer download with checksum validation, silent installation, and MDM-managed reinstalls. Use when an application is crashing, corrupted, or behaving incorrectly and a reinstall is the appropriate resolution.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - list_installed_apps
  - check_app_integrity
  - check_app_permissions
  - check_mdm_enrollment
  - uninstall_app
  - download_installer
  - reset_app_preferences
  - clear_app_cache
metadata:
  prerequisites:
    before-corrective:
      - list_installed_apps
      - check_app_integrity
      - check_app_permissions
      - check_mdm_enrollment
  maxAggregateRisk: high
  userLabel: "App crashing or needs reinstall"
  examples:
    - "an app keeps crashing every time I open it"
    - "my application is corrupted and won't launch"
    - "software is behaving strangely and needs a fresh install"
    - "I need to reinstall an application cleanly"
    - "the app keeps freezing and crashing"
  pill:
    label: App Issue
    goal: An app is crashing, won't launch, or is behaving incorrectly — check what's wrong, try non-destructive fixes (preferences, cache, permissions), and either guide me through a reinstall via Self Service / IT, or escalate
    icon: Download
    iconClass: text-cyan-500
    order: 8
---

## When to use

Use this skill when the user:
- Reports an application crashes immediately on launch or is stuck in a crash loop
- Gets "app is damaged and can't be opened" or code signature errors
- Reports an application that was working has started behaving incorrectly after an OS update
- Needs to reinstall a specific version of software after accidental deletion
- IT has instructed them to reinstall a specific application
- Asks "can you reinstall X?" or "my app keeps crashing, can you fix it?"

Do NOT use this skill to reinstall security agents (CrowdStrike, SentinelOne, Jamf, etc.) — those must be reinstalled through the management console, not through a manual download. Use the `security-agent-repair` skill instead.

---

## Steps

**Step 1 — Confirm the application is installed**
Call `list_installed_apps` with `filter` set to the application name. This confirms whether the app is installed, its current version, and its install path. If the app is not found, skip to Step 6 (download) directly.

**Step 2 — Check application integrity**
Call `check_app_integrity` with the app name to verify its code signature and Gatekeeper approval status. If the signature is invalid:
- The app bundle is corrupt and reinstallation is confirmed as the right action
- Inform the user that the corruption is why the app is misbehaving — it is not a user error

If the signature is valid, the crash may be caused by corrupt preferences or cache rather than the binary itself — consider calling `reset_app_preferences` and `clear_app_cache` before proceeding to a full reinstall, as those are faster and non-destructive.

**Step 3 — Check required system permissions**
Call `check_app_permissions` with `appName` set to the application name from Step 1. The `appName` parameter is **required** (no default). Use the display name returned by `list_installed_apps` — the tool validates the name with a restricted character regex (letters, digits, spaces, `_`, `-`, `.`, `'`), so special characters will be rejected.

This verifies the app has the permissions it needs (Full Disk Access, Accessibility, Camera, Microphone, etc.). Missing permissions are a common cause of apps crashing silently on launch without any error message. If permissions are missing, guide the user to System Settings → Privacy & Security to grant them before reinstalling — a reinstall will not restore permissions automatically.

**Step 4 — Check MDM enrollment**
Call `check_mdm_enrollment` to determine if the device is MDM-managed. If enrolled:
- Prefer IT/MDM-triggered reinstall over manual download — it ensures the correct version, license, and configuration are applied automatically
- Inform the user that IT can push a reinstall through Jamf or Intune and ask if they have a self-service portal available (Jamf Self Service, Company Portal)
- Only proceed with manual download (Step 6) if the user confirms MDM reinstall is not available or has already been tried

**Step 5 — Uninstall the existing application**
Call `uninstall_app` with `dryRun: true` and `deep: true` to show the app bundle, support files, caches, preferences, and logs that would be removed, along with the total size. Review the list with the user — confirm there are no files they want to preserve (e.g. local documents stored in the app's support directory).

If the user confirms, call `uninstall_app` with `dryRun: false` and `deep: true` to perform a clean removal. A deep uninstall ensures the reinstall starts from a completely clean state — leftover corrupt support files can cause a freshly installed app to inherit the same problems.

**Step 6 — Download the installer**
Call `download_installer` with the official download URL for the application. Always provide a `checksumSha256` if available — obtain it from the vendor's official download page or release notes. The tool rejects non-HTTPS URLs automatically.

Confirm with the user where the official download URL comes from before proceeding — never use third-party download sites. For common applications:
- Zoom: zoom.us/download
- Slack: slack.com/downloads
- Microsoft Office: Microsoft 365 portal or aka.ms/office-install
- Adobe apps: Adobe Creative Cloud desktop app (do not download installers directly)

**Step 7 — Run the installer (user-driven — no tool available)**
Automated installer execution is NOT available in the current build — the `run_installer` tool is planned but not yet implemented. Instead, guide the user to run the downloaded installer manually. The installer's local path was reported in Step 6's `download_installer` result (the `filePath` field).

Platform-specific instructions to surface to the user:
- **macOS `.dmg`** — double-click the file in Finder, drag the app into the Applications folder when the mount window appears, then eject the DMG.
- **macOS `.pkg`** — double-click to launch Installer.app; follow the prompts (admin password will be required for system-level installs).
- **Windows `.msi`** or **`.exe`** — double-click to launch the installer wizard; follow the prompts (UAC admin prompt will appear for system-level installs).

Wait for the user to confirm the installation finished before proceeding. Then call `list_installed_apps` again with `filter` set to the app name to confirm the new version is now registered in the system. If the app does not appear after a few minutes, ask the user whether the installer completed successfully or reported an error.

> When `run_installer` ships, this step will regain its automated dry-run → consent → silent install flow. Until then, the manual path above is the supported workflow.

**Step 8 — Restore permissions**
Call `check_app_permissions` again after reinstallation. Reinstalling does not automatically restore previously granted permissions — the user must re-grant them in System Settings → Privacy & Security. Walk the user through granting each required permission identified in Step 3.

**Step 9 — Test the application**
Ask the user to launch the application and confirm it opens without crashing. If it crashes again immediately after a clean reinstall with correct permissions:
- The issue may be OS-level incompatibility (app version too old for current macOS/Windows)
- Check the app's system requirements against the user's OS version
- Advise the user to check the vendor's release notes for known compatibility issues

**Step 10 — Final report**
Summarise what was found (corrupt signature, missing permissions, outdated version, etc.), what was done (uninstall depth, installer source, checksum validation result, new version installed), and any follow-up steps (permissions to grant, IT contact for MDM reinstall).

---

## Graceful degradation when uninstall / install requires admin

Steps 5 (`uninstall_app`) and 7 (manual installer run, since `run_installer` is not yet implemented) require administrator privileges. For non-admin users the G4 scope check returns `outcome: "denied"` for `uninstall_app`, and the manual installer run in Step 7 will hit a UAC / admin password prompt the user can't satisfy. This does **not** abort the workflow — the diagnostic phase (Steps 1–4) and the non-destructive fixes (`reset_app_preferences`, `clear_app_cache` from Step 2) still run.

When the corrective steps would deny:

1. **Don't treat the denied step as a failure.** State plainly that uninstalling or installing requires administrator privileges and the agent could not run it.
2. **Try non-destructive fixes first.** Step 2 already suggests `reset_app_preferences` + `clear_app_cache` before a full reinstall. These resolve a meaningful share of "app crashes on launch" tickets without uninstall — and they work for non-admin users without admin. Confirm the user wants a full reinstall before going further.
3. **Self-service path for MDM-enrolled users (the dominant enterprise case).** Step 4's `check_mdm_enrollment` reveals whether the device is managed. If yes, the standard non-admin install/reinstall path is the corporate Self Service catalog:
   - **Jamf:** open the "Self Service" app from /Applications; search for the app; click Install or Reinstall.
   - **Intune:** open the "Company Portal" app from /Applications (macOS) or Start Menu (Windows); search for the app; click Install.
   - **Munki:** open the "Managed Software Center" app from /Applications; search for the app; click Install.
   These portals handle privilege escalation server-side via the management agent — the user can install without local admin. The agent does not currently integrate with these catalogs (planned); for now, point the user to the right portal app and the search term to use.
4. **For BYOD / non-managed users:** the user can typically run the installer themselves with their own admin password.
   - **macOS:** double-click the downloaded .dmg/.pkg → drag to /Applications → enter admin password when prompted.
   - **Windows:** right-click the .msi/.exe → Run as administrator → follow the UAC prompt.
5. **Always package the diagnostic for IT escalation** — the end-of-run ticket captures app integrity result, permission state, MDM enrollment, and which steps denied so IT can pick up cleanly without further back-and-forth.

---

## Edge cases

- **Apps that cannot be silently installed** — some applications (particularly Adobe products, some enterprise tools) require user interaction during install despite silent flags. `run_installer` will time out or fail for these. Guide the user to run the installer manually if silent install is not supported
- **macOS App Store apps** — apps installed via the Mac App Store cannot be reinstalled through this skill — they have no downloadable installer. Guide the user to the App Store → Purchased → click the cloud download icon to reinstall
- **License activation after reinstall** — reinstalling does not restore software licenses. Apps like Microsoft Office, Adobe Creative Cloud, or JetBrains IDEs will require re-activation after reinstall. Warn the user before proceeding and ensure they have their license key or account credentials
- **System Integrity Protection blocks some installs** — on macOS with SIP enabled, installers cannot write to protected system directories (/System, /usr, etc.). If `run_installer` fails with a permissions error on a .pkg that normally installs system components, the user may need to run it manually with their admin password
- **Gatekeeper quarantine on downloaded files** — files downloaded via Node.js `https.get()` do not receive the quarantine extended attribute, so Gatekeeper will not block them at launch time. This is the expected behaviour — the checksum validation in `download_installer` provides integrity assurance instead
- **Rosetta 2 requirement** — some older Mac apps ship Intel-only binaries. On Apple Silicon Macs these run via Rosetta 2, which must be installed separately. If `run_installer` fails with an architecture error, check if Rosetta is installed: `softwareupdate --install-rosetta --agree-to-license`
- **Corporate app catalogue** — on MDM-managed machines, IT may restrict which apps can be installed. If `run_installer` fails with a policy or MDM restriction error, the user must request the app through the approved IT channel (Jamf Self Service or equivalent) rather than installing it manually
- **Partial uninstall failures** — `uninstall_app` may not find all support files for apps with non-standard bundle IDs or unusual install structures (e.g. apps that install to /usr/local). If problems persist after reinstall, check for any remaining files in ~/Library/Application Support manually
