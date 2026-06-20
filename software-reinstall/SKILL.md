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
  - query_self_service_catalog
  - trigger_self_service_install
  - uninstall_app
  - download_installer
  - run_installer
  - reset_app_preferences
  - clear_app_cache
  - wait_for_user_ack
  - request_user_input
metadata:
  prerequisites:
    before-corrective:
      - list_installed_apps
      - check_app_integrity
      - check_app_permissions
      - check_mdm_enrollment
  maxAggregateRisk: high
  userLabel: "App crashing or needs reinstall"
    # Crash/freeze examples anchor on PERSISTENCE — crashes every launch / won't
    # launch / stays broken after a restart — the reinstall signal. A one-off
    # frozen app is process-manager; an email/Outlook crash is email-repair.
  examples:
    - "an app keeps crashing every time I open it"
    - "my application is corrupted and won't launch"
    - "software is behaving strangely and needs a fresh install"
    - "I need to reinstall an application cleanly"
    - "the app is still broken even after restarting it"
  pill:
    label: App Issue
    goal: An app is crashing, won't launch, or is behaving incorrectly — check what's wrong, try non-destructive fixes (preferences, cache, permissions), and either guide me through a reinstall via Self Service / IT, or escalate
    icon: Download
    iconClass: text-cyan-500
    order: 7
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
Call `list_installed_apps` with `filter` set to the application name. Establishes whether the app is installed, its current version, and its install path. If the app is not found, downstream Conditions on Steps 5/5b/10 still skip safely (they need an installed app); the run proceeds via the install-from-scratch path (Steps 7–13).

**Step 2 — Check application integrity**
Call `check_app_integrity` with the app name. If the signature is invalid, the bundle is corrupt and reinstallation is the right action (Steps 10+). If the signature is valid AND the user reports misbehavior, Steps 5/5b/6 try non-destructive fixes (preferences + cache reset) before any reinstall.

**Step 3 — Check required system permissions**
Call `check_app_permissions` with `appName` set to the application name. The `appName` parameter is **required** — use the display name returned by `list_installed_apps`. The tool validates with a restricted character regex (letters, digits, spaces, `_`, `-`, `.`, `'`); special characters are rejected.

Missing permissions (Full Disk Access, Accessibility, Camera, Microphone, etc.) are a common cause of apps crashing silently on launch. Surface any missing perms in the response. Step 15's post-install ack will gate the user's re-grant work — a reinstall does NOT restore permissions automatically.

**Step 4 — Check MDM enrollment**
Call `check_mdm_enrollment`. Determines whether the device is MDM-managed, which gates Step 7's Self Service catalog path. On enrolled devices the catalog is the **strongly preferred** install route because (a) the corp-licensed version is the supported version, (b) the catalog applies management-agent post-install configuration (license keys, MDM profiles, firewall exceptions, login items), and (c) the catalog's agent handles privilege escalation server-side (no local admin password).

**Step 4b — Capture fix-first vs. straight-to-reinstall preference**
`Condition:` only run if Step 2's `check_app_integrity` returned `signatureValid: true` (the binary is intact, so non-destructive fixes are worth offering). Skip when `signatureValid` is `false`/`null` — the bundle is corrupt; go straight to the reinstall path. Call `wait_for_user_ack`:

```yaml
prompt: "The app's code signature is intact, so the binary itself isn't corrupt. I can try non-destructive fixes first (reset preferences + clear cache — your data stays intact), or skip straight to a clean reinstall. Which do you want?"
options:
  - { id: "try-fixes", label: "Try non-destructive fixes first", kind: "primary" }
  - { id: "reinstall", label: "Skip — reinstall cleanly",       kind: "secondary" }
```

This converts the prior free-text "user reports misbehaving vs. explicitly asked for a reinstall" judgement into a concrete `choice` value that Steps 5/5b branch on.

**Step 5 — Try non-destructive fix: reset app preferences**
`Condition:` only run if (a) Step 2's `check_app_integrity` returned `signatureValid: true` AND (b) Step 4b returned `choice: "try-fixes"` (`inputsFrom: [{ step: "4b", field: "choice" }]`). Skip if the signature is invalid (the binary itself is corrupt — go straight to reinstall) or Step 4b returned `choice: "reinstall"`.

Call `reset_app_preferences` with `appName` set to the same display name from Step 3. G4 auto-triggers the dry-run preview (`tool.meta.destructive: true` + `supportsDryRun: true`) listing which preference files would be removed, then the consent gate fires (`requiresConsent: true`). Warn in the rationale that this resets the app's settings — accounts may need re-adding for some apps.

**Step 5b — Try non-destructive fix: clear app cache**
`Condition:` same as Step 5. Call `clear_app_cache` with `appName`. Fires silently (`medium + non-destructive + no-consent` — acceptable: cache regenerates on next launch, and the user invoked this skill expecting fixes).

**Step 6 — Wait for user to test if non-destructive fixes worked**
`Condition:` only run if Step 5 ran (which implies Step 5b also ran). Call `wait_for_user_ack`:

```yaml
prompt: "I reset the app's preferences and cleared its cache — both are non-destructive (your data is intact). Try opening the app now. Did that fix the issue?"
options:
  - { id: "fixed",        label: "It works now",                 kind: "primary" }
  - { id: "still-broken", label: "Still crashing / misbehaving", kind: "secondary" }
  - { id: "skip",         label: "Skip — go straight to reinstall", kind: "cancel" }
```

On `fixed`: report success and end the run (Step 16 final report). On `still-broken` or `skip`: proceed to Step 7 (managed-install attempt). Without this gate, the skill would escalate to uninstall + reinstall immediately, wasting time on a fix that already worked.

**Step 7 — Query Self Service catalog (MDM-managed path)**
`Condition:` only run if (a) Step 4 returned `enrolled: true` AND (b) Step 6 returned `still-broken` OR `skip` (non-destructive fixes didn't help) OR Steps 5/6 were skipped (signature invalid or explicit reinstall request).

Call `query_self_service_catalog`. Reports which of Jamf Self Service, Intune Company Portal, or Munki Managed Software Center is installed and (for Munki) enumerates available apps:
- `catalog_type: "munki"` + `enumeration_available: true` → match the user's app name against `apps[]`; pick the matching identifier for Step 8.
- `catalog_type: "jamf"` / `"intune"` + `enumeration_available: false` → no local cache; the user will manually find the app in the catalog UI (Step 9's ack will handle that).
- `catalog_type: "none"` → no catalog on this device; skip Step 8 and fall through to the manual reinstall path (Steps 10–14).

**Step 8 — Trigger Self Service deep-link**
`Condition:` only run if (a) Step 7 returned `catalog_present: true` AND (b) an `appIdentifier` is known (Munki enumeration matched the user's app name). For Jamf/Intune where enumeration is unavailable, skip this step — Step 9's ack instructs the user to find the app manually.

Call `trigger_self_service_install` with `appIdentifier` set to the Munki manifest item name (or `jamf://` policy ID / `intunecompanyportal://` app ID if the user supplied one). The tool opens the catalog companion app pre-filtered to the install screen via a deep-link URL.

**Step 9 — Wait for user to complete Self Service install**
`Condition:` only run if Step 7 returned `catalog_present: true` (regardless of whether Step 8 ran — for Jamf/Intune the user opens Self Service manually). Call `wait_for_user_ack`:

```yaml
prompt: "I {opened Self Service for you|need you to open Self Service and search for `<app>`}. Click Install and let me know when the catalog reports the install completed."
options:
  - { id: "installed",     label: "Install completed",         kind: "primary" }
  - { id: "app-not-found", label: "App not in the catalog",    kind: "secondary" }
  - { id: "failed",        label: "Install failed in catalog", kind: "secondary" }
  - { id: "skip",          label: "Skip — use manual install", kind: "cancel" }
```

Substitute the first sentence based on Step 8: "opened Self Service for you" if Step 8 ran with a known identifier, "need you to open Self Service" otherwise.

On `installed`: jump to Step 14 (verify the catalog install registered). On `app-not-found` / `failed` / `skip`: fall through to Step 10 (manual uninstall + reinstall path).

**Step 10 — Uninstall the existing application**
`Condition:` only run if (a) the catalog path failed (Step 7 returned `none`, OR Step 9 returned `app-not-found` / `failed` / `skip`) OR (b) Step 4 returned `enrolled: false` (BYOD/unmanaged). Skip if the catalog path succeeded — the catalog handled the uninstall internally.

Call `uninstall_app` with `deep: true`. G4 auto-triggers the dry-run preview (`high + destructive: true + supportsDryRun: true`) showing the app bundle, support files, caches, preferences, and logs that would be removed (with total size), followed by the consent gate. A deep uninstall ensures the reinstall starts from a completely clean state.

**Step 11 — Capture the vendor download URL**
`Condition:` only run if Step 10 ran (the manual install path is active). Call `request_user_input`:

```yaml
prompt: "What's the official download URL for {app}? Use only the vendor's official site (e.g. zoom.us/download, slack.com/downloads, aka.ms/office-install). Never use third-party download mirrors. Provide the SHA-256 checksum too if the vendor publishes one — leave URL blank to skip the reinstall."
placeholder: "https://zoom.us/client/latest/ZoomInstallerFull.pkg"
validator: "^https://[A-Za-z0-9.\\-/_%?=&:]+$"
```

The validator forces HTTPS — `download_installer` rejects non-HTTPS URLs anyway, the regex enforces the same upfront. If the user submits an empty value, skip Steps 12–14 and end the run with "I need an official vendor URL to complete the reinstall — please open a ticket with IT or get the URL from your vendor portal".

Replaces the chat-narrate "Confirm with the user where the official download URL comes from" pattern — that prose had no actual mechanism to receive an answer.

**Step 12 — Download the installer**
`Condition:` only run if Step 11 returned a non-empty `value`. Call `download_installer` with `url` from Step 11 (`inputsFrom: [{ step: 11, field: "value" }]`). The tool rejects non-HTTPS URLs automatically and validates the SHA-256 checksum if supplied. Files downloaded via Node.js `https.get()` do NOT receive the macOS Gatekeeper quarantine attribute, so the checksum validation is the primary integrity assurance.

**Step 13 — Run the installer**
`Condition:` only run if Step 12 returned `success: true`. Call `run_installer` with `installerPath` from Step 12 (`inputsFrom: [{ step: 12, field: "installerPath" }]`). G4 auto-triggers the dry-run preview (`high + destructive: true + supportsDryRun: true`) showing the exact command (e.g. `installer -pkg <path> -target /` for a .pkg, `msiexec /i <path> /qn /norestart` for an .msi), followed by the consent gate.

The `installerType` parameter is optional — when omitted, the tool auto-detects from the file extension. Supply it explicitly only when the extension is ambiguous (defence-in-depth against type-confusion). Allowed values: `pkg`, `dmg`, `msi`, `exe`.

Routes through the privileged helper daemon for non-admin users (helper allowlist contains `run_installer`). With the helper available (default), completes silently for **all users — admin and non-admin alike**.

**Step 14 — Verify the install registered**
`Condition:` only run if Step 9 returned `installed` OR Step 13 returned `success: true` (either install path completed). Call `list_installed_apps` again with `filter` set to the app name to confirm the new version is registered. If the app does not appear within a minute or two, the installer may have completed but the OS application database hasn't refreshed — surface that in the response so the user knows to check /Applications (macOS) or Start menu / Programs and Features (Windows) manually.

**Step 15 — Wait for user to grant permissions + test launch**
`Condition:` only run if Step 14 confirmed the install. Call `wait_for_user_ack`:

```yaml
prompt: "The app is installed. Two things I need from you: (a) if Step 3 flagged any missing permissions (Full Disk Access, Accessibility, Camera, etc.), grant them now in System Settings → Privacy & Security — a reinstall does NOT restore permissions automatically; (b) launch the app and confirm it opens without crashing. Let me know how it goes."
options:
  - { id: "works",         label: "App works",                       kind: "primary" }
  - { id: "still-crashes", label: "Still crashes after reinstall",   kind: "secondary" }
  - { id: "skip",          label: "Skip — I'll test later",          kind: "cancel" }
```

Replaces the chat-narrate from old Steps 8+9 ("Walk the user through granting each required permission" + "Ask the user to launch the application and confirm it opens"). Combining both into one gate avoids two acks back-to-back. On `still-crashes`: surface OS-version-incompatibility hints in the response — the app version may be too old for the current macOS/Windows release; check vendor release notes.

**Step 16 — Final report**
Summarise what was found (corrupt signature, missing permissions, outdated version, etc.), which path resolved it (non-destructive fixes, Self Service catalog, manual uninstall + reinstall), the installer source (catalog name / vendor URL + checksum validation result), the new version registered in Step 14, and any follow-up steps (specific permissions to grant, IT contact for MDM reinstall if the helper was unavailable).

---

## Graceful degradation when uninstall / install requires admin

Steps 10 (`uninstall_app`) and 13 (`run_installer`) require administrator privileges to execute the underlying OS commands. The agent handles this transparently in two modes:

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): both steps route through the helper and complete silently for **all users — admin and non-admin alike**. The user sees the install/uninstall succeed end-to-end. No "this requires admin" messaging is needed in the response.

**When the helper is unavailable** (`HELPER_DAEMON_ENABLED=false`, helper not installed, or helper unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`): the corrective steps deny and the diagnostic continues to completion. The diagnostic phase (Steps 1–4) and the non-destructive fixes (Steps 5–6: `reset_app_preferences` and `clear_app_cache`) still run regardless — both touch only the user's own files.

In the helper-unavailable fallback case:

1. **Don't treat the denied step as a failure.** State plainly that the agent couldn't run the install/uninstall on this device and explain why (helper unavailable / disabled / non-admin user without helper routing).
2. **Try non-destructive fixes first.** Steps 5–6 already run `reset_app_preferences` + `clear_app_cache` and gate on the user's "did that fix it?" ack before any reinstall. These resolve a meaningful share of "app crashes on launch" tickets — and they work for non-admin users without admin.
3. **Self-service path for MDM-enrolled users (the dominant enterprise case).** Steps 7–9 detect the catalog via `query_self_service_catalog`, deep-link via `trigger_self_service_install`, and ack the user's catalog-side install. If for some reason those steps were skipped, point the user manually:
   - **Jamf:** open the "Self Service" app from /Applications; search for the app; click Install or Reinstall.
   - **Intune:** open the "Company Portal" app from /Applications (macOS) or Start Menu (Windows); search for the app; click Install.
   - **Munki:** open the "Managed Software Center" app from /Applications; search for the app; click Install.
   These portals handle privilege escalation server-side via the management agent — the user installs without local admin.
4. **For BYOD / non-managed users:** the user can typically run the installer themselves with their own admin password.
   - **macOS:** double-click the downloaded .dmg/.pkg → drag to /Applications → enter admin password when prompted.
   - **Windows:** right-click the .msi/.exe → Run as administrator → follow the UAC prompt.
5. **Always package the diagnostic for IT escalation** — the end-of-run ticket captures app integrity result, permission state, MDM enrollment, and which steps denied so IT can pick up cleanly. IT can also investigate why the helper is unavailable on this device when `helper-unavailable` denies surface.

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
