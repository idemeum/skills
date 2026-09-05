---
name: software-reinstall
description: Installs an application the user does not have, and repairs one that is broken by reinstalling it cleanly. Covers Self Service catalog install on managed devices, signature verification, thorough uninstallation, installer download with checksum validation, and silent installation. Use when a user needs software they are missing, or when an application is crashing, corrupted, or behaving incorrectly and a reinstall is the appropriate resolution.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - survey_app
  - list_installed_apps
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
      - survey_app
      - check_mdm_enrollment
  maxAggregateRisk: high
  userLabel: "Install an app, or reinstall a broken one"
    # Two intents, both already served by the steps below: install-from-scratch
    # (Step 1 finds nothing, the run proceeds via Steps 5-11) and repair-by-
    # reinstall. Only the second was expressed here, so 'I need Slack' routed
    # nowhere despite the capability existing.
    #
    # Crash/freeze examples anchor on PERSISTENCE — crashes every launch / won't
    # launch / stays broken after a restart — the reinstall signal. A one-off
    # frozen app is process-manager; an email/Outlook crash is email-repair.
  examples:
    - "I need Slack installed on my laptop"
    - "how do I get Zoom on this machine"
    - "an app keeps crashing every time I open it"
    - "my application is corrupted and won't launch"
    - "software is behaving strangely and needs a fresh install"
    - "I need to reinstall an application cleanly"
    - "the app is still broken even after restarting it"
  pill:
    label: Install or Fix App
    goal: I need an app installed, or one I have is crashing or misbehaving — install it from the company catalogue if I don't have it, or check what's wrong and try non-destructive fixes before reinstalling
    icon: Download
    iconClass: text-cyan-500
    order: 7
---

## When to use

Use this skill when the user:
- Needs an application they do not currently have — Step 1 finds nothing installed and the run proceeds via the install-from-scratch path (Steps 5–11), preferring the Self Service catalogue on a managed device
- Reports an application crashes immediately on launch or is stuck in a crash loop
- Gets "app is damaged and can't be opened" or code signature errors
- Reports an application that was working has started behaving incorrectly after an OS update
- Needs to reinstall a specific version of software after accidental deletion
- IT has instructed them to reinstall a specific application
- Asks "can you reinstall X?" or "my app keeps crashing, can you fix it?"

Do NOT use this skill to reinstall security agents (CrowdStrike, SentinelOne, Jamf, etc.) — those must be reinstalled through the management console, not through a manual download. Use the `security-agent-repair` skill instead.

---

## Steps

**Step 1 — Survey the application**
Call `survey_app` with `appName` set to the application name. One call returns whether it is installed, whether its bundle is intact, and what permissions it holds. Read:
- `installed` — false means there is nothing to repair: the run proceeds down the install-from-scratch path and the non-destructive fixes and the uninstall all skip safely.
- `matches` — every catalogue hit. More than one means the name was ambiguous; ask the user which they mean before acting, rather than guessing at the first.
- `integrity` — read `integrity.signatureValid` **against `installed`**, because a null means two different things:
  - `integrity.signatureValid: false` → the bundle is corrupt; resets cannot help, go to the reinstall path.
  - `integrity.signatureValid: true` → the binary is fine; this is what the non-destructive fixes exist for.
  - null **with `installed: false`** → nothing is there. Install from scratch; there is nothing to lose.
  - null **with `installed: true`** → the app IS present and the check did not complete. That is not evidence of corruption. Treat it as intact and offer the non-destructive fixes: they are reversible and cost the user a minute, whereas uninstalling a working application on an unproven suspicion is not. Never let an unknown route to `uninstall_app`.
- `permissions` — missing Full Disk Access, Accessibility, Camera or Microphone is a common cause of an app crashing silently on launch. Surface any that are missing. A reinstall does NOT restore them; the post-install acknowledgement gates the user's re-grant work.

**Step 2 — Check MDM enrollment**
Call `check_mdm_enrollment`. Gates Step 5's Self Service catalog path. **On a device the Environment block already reports as unenrolled, omit this step and Steps 5–7 entirely** — the answer is known before the plan is written, and the catalog path cannot apply.

*On an enrolled device* the catalog is the strongly preferred install route: the corp-licensed build is the supported one, the management agent applies post-install configuration (license keys, profiles, firewall exceptions, login items), and it escalates privilege server-side so the user needs no local admin. *On an unmanaged device none of that is available* — go to the manual uninstall + reinstall path at Step 8 and do not mention Self Service to the user.

**Step 2b — Capture fix-first vs. straight-to-reinstall preference**
`Condition:` run when Step 1 reported `installed: true` AND `integrity.signatureValid` is true **or null** (intact, or unproven — either way the non-destructive fixes are worth offering). Skip only when `integrity.signatureValid` is `false` (the bundle is genuinely corrupt) or `installed` is false (nothing to fix): both go to the reinstall path. Call `wait_for_user_ack`:

```yaml
prompt: "The app's code signature is intact, so the binary itself isn't corrupt. I can try non-destructive fixes first (reset preferences + clear cache — your data stays intact), or skip straight to a clean reinstall. Which do you want?"
options:
  - { id: "try-fixes", label: "Try non-destructive fixes first", kind: "primary" }
  - { id: "reinstall", label: "Skip — reinstall cleanly",       kind: "secondary" }
```

This converts the prior free-text "user reports misbehaving vs. explicitly asked for a reinstall" judgement into a concrete `choice` value that Steps 3/3b branch on.

**Step 3 — Try non-destructive fix: reset app preferences**
`Condition:` only run if (a) Step 1 reported `installed: true` and `integrity.signatureValid` is true or null AND (b) Step 2b returned `choice: "try-fixes"` (`inputsFrom: [{ step: "2b", field: "choice" }]`). Skip if the signature is `false` (the binary itself is corrupt — go straight to reinstall) or Step 2b returned `choice: "reinstall"`.

Call `reset_app_preferences` with `appName` set to the same display name from Step 3. G4 auto-triggers the dry-run preview (`tool.meta.destructive: true` + `supportsDryRun: true`) listing which preference files would be removed, then the consent gate fires (`requiresConsent: true`). Warn in the rationale that this resets the app's settings — accounts may need re-adding for some apps.

**Step 3b — Try non-destructive fix: clear app cache**
`Condition:` same as Step 3. Call `clear_app_cache` with `appName`. Fires silently (`medium + non-destructive + no-consent` — acceptable: cache regenerates on next launch, and the user invoked this skill expecting fixes).

**Step 4 — Wait for user to test if non-destructive fixes worked**
`Condition:` only run if Step 3 ran (which implies Step 3b also ran). Call `wait_for_user_ack`:

```yaml
prompt: "I reset the app's preferences and cleared its cache — both are non-destructive (your data is intact). Try opening the app now. Did that fix the issue?"
options:
  - { id: "fixed",        label: "It works now",                 kind: "primary" }
  - { id: "still-broken", label: "Still crashing / misbehaving", kind: "secondary" }
  - { id: "skip",         label: "Skip — go straight to reinstall", kind: "cancel" }
```

On `fixed`: report success and end the run (Step 14 final report). On `still-broken` or `skip`: proceed to Step 5 (managed-install attempt). Without this gate, the skill would escalate to uninstall + reinstall immediately, wasting time on a fix that already worked.

**Step 5 — Query Self Service catalog (MDM-managed path)**
`Condition:` only run if (a) Step 2 returned `enrolled: true` AND (b) Step 4 returned `still-broken` OR `skip` (non-destructive fixes didn't help) OR Steps 3/4 were skipped (signature invalid or explicit reinstall request).

Call `query_self_service_catalog`. Reports which of Jamf Self Service, Intune Company Portal, or Munki Managed Software Center is installed and (for Munki) enumerates available apps:
- `catalog_type: "munki"` + `enumeration_available: true` → match the user's app name against `apps[]`; pick the matching identifier for Step 6.
- `catalog_type: "jamf"` / `"intune"` + `enumeration_available: false` → no local cache; the user will manually find the app in the catalog UI (Step 7's ack will handle that).
- `catalog_type: "none"` → no catalog on this device; skip Step 6 and fall through to the manual reinstall path (Steps 8–12).

**Step 6 — Trigger Self Service deep-link**
`Condition:` only run if (a) Step 5 returned `catalog_present: true` AND (b) an `appIdentifier` is known (Munki enumeration matched the user's app name). For Jamf/Intune where enumeration is unavailable, skip this step — Step 7's ack instructs the user to find the app manually.

Call `trigger_self_service_install` with `appIdentifier` set to the Munki manifest item name (or `jamf://` policy ID / `intunecompanyportal://` app ID if the user supplied one). The tool opens the catalog companion app pre-filtered to the install screen via a deep-link URL.

**Step 7 — Wait for user to complete Self Service install**
`Condition:` only run if Step 5 returned `catalog_present: true` (regardless of whether Step 6 ran — for Jamf/Intune the user opens Self Service manually). Call `wait_for_user_ack`:

```yaml
prompt: "I {opened Self Service for you|need you to open Self Service and search for `<app>`}. Click Install and let me know when the catalog reports the install completed."
options:
  - { id: "installed",     label: "Install completed",         kind: "primary" }
  - { id: "app-not-found", label: "App not in the catalog",    kind: "secondary" }
  - { id: "failed",        label: "Install failed in catalog", kind: "secondary" }
  - { id: "skip",          label: "Skip — use manual install", kind: "cancel" }
```

Substitute the first sentence based on Step 6: "opened Self Service for you" if Step 6 ran with a known identifier, "need you to open Self Service" otherwise.

On `installed`: jump to Step 12 (verify the catalog install registered). On `app-not-found` / `failed` / `skip`: fall through to Step 8 (manual uninstall + reinstall path).

**Step 8 — Uninstall the existing application**
`Condition:` only run if (a) the catalog path failed (Step 5 returned `none`, OR Step 7 returned `app-not-found` / `failed` / `skip`) OR (b) Step 2 returned `enrolled: false` (BYOD/unmanaged). Skip if the catalog path succeeded — the catalog handled the uninstall internally.

Call `uninstall_app` with `deep: true`. G4 auto-triggers the dry-run preview (`high + destructive: true + supportsDryRun: true`) showing the app bundle, support files, caches, preferences, and logs that would be removed (with total size), followed by the consent gate. A deep uninstall ensures the reinstall starts from a completely clean state.

**Step 9 — Capture the vendor download URL**
`Condition:` only run if Step 8 ran (the manual install path is active). Call `request_user_input`:

```yaml
prompt: "What's the official download URL for {app}? Use only the vendor's official site (e.g. zoom.us/download, slack.com/downloads, aka.ms/office-install). Never use third-party download mirrors. Provide the SHA-256 checksum too if the vendor publishes one — leave URL blank to skip the reinstall."
placeholder: "https://zoom.us/client/latest/ZoomInstallerFull.pkg"
validator: "^https://[A-Za-z0-9.\\-/_%?=&:]+$"
```

The validator forces HTTPS — `download_installer` rejects non-HTTPS URLs anyway, the regex enforces the same upfront. If the user submits an empty value, skip Steps 10–12 and end the run with "I need an official vendor URL to complete the reinstall — please open a ticket with IT or get the URL from your vendor portal".

Replaces the chat-narrate "Confirm with the user where the official download URL comes from" pattern — that prose had no actual mechanism to receive an answer.

**Step 10 — Download the installer**
`Condition:` only run if Step 9 returned a non-empty `value`. Call `download_installer` with `url` from Step 9 (`inputsFrom: [{ step: 9, field: "value" }]`). The tool rejects non-HTTPS URLs automatically and validates the SHA-256 checksum if supplied. Files downloaded via Node.js `https.get()` do NOT receive the macOS Gatekeeper quarantine attribute, so the checksum validation is the primary integrity assurance.

**Step 11 — Run the installer**
`Condition:` only run if Step 10 returned `success: true`. Call `run_installer` with `installer_path` set to Step 10's `localPath` output (`inputsFrom: [{ step: 10, field: "localPath" }]`). **Param keys are snake_case (`installer_path`, `installer_type`)** — the tool routes through the privileged helper, whose wire contract is snake_case. G4 auto-triggers the dry-run preview (`high + destructive: true + supportsDryRun: true`) showing the exact command (e.g. `installer -pkg <path> -target /` for a .pkg, `msiexec /i <path> /qn /norestart` for an .msi), followed by the consent gate.

The `installer_type` parameter is optional — when omitted, the tool auto-detects from the file extension. Supply it explicitly only when the extension is ambiguous (defence-in-depth against type-confusion). Allowed values: `pkg`, `dmg`, `msi`, `exe`.

Routes through the privileged helper daemon for non-admin users (helper allowlist contains `run_installer`). With the helper available (default), completes silently for **all users — admin and non-admin alike**.

**Step 12 — Verify the install registered**
`Condition:` only run if Step 7 returned `installed` OR Step 11 returned `success: true` (either install path completed). Call `list_installed_apps` again with `filter` set to the app name to confirm the new version is registered. If the app does not appear within a minute or two, the installer may have completed but the OS application database hasn't refreshed — surface that in the response so the user knows to check /Applications (macOS) or Start menu / Programs and Features (Windows) manually.

**Step 13 — Wait for user to grant permissions + test launch**
`Condition:` only run if Step 12 confirmed the install. Call `wait_for_user_ack`:

```yaml
prompt: "The app is installed. Two things I need from you: (a) if Step 3 flagged any missing permissions (Full Disk Access, Accessibility, Camera, etc.), grant them now in System Settings → Privacy & Security — a reinstall does NOT restore permissions automatically; (b) launch the app and confirm it opens without crashing. Let me know how it goes."
options:
  - { id: "works",         label: "App works",                       kind: "primary" }
  - { id: "still-crashes", label: "Still crashes after reinstall",   kind: "secondary" }
  - { id: "skip",          label: "Skip — I'll test later",          kind: "cancel" }
```

Replaces the chat-narrate from old Steps 6+9 ("Walk the user through granting each required permission" + "Ask the user to launch the application and confirm it opens"). Combining both into one gate avoids two acks back-to-back. On `still-crashes`: surface OS-version-incompatibility hints in the response — the app version may be too old for the current macOS/Windows release; check vendor release notes.

**Step 14 — Final report**
Summarise what was found (corrupt signature, missing permissions, outdated version, etc.), which path resolved it (non-destructive fixes, Self Service catalog, manual uninstall + reinstall), the installer source (catalog name / vendor URL + checksum validation result), the new version registered in Step 12, and any follow-up steps (specific permissions to grant, IT contact for MDM reinstall if the helper was unavailable).

---

## Graceful degradation when uninstall / install requires admin

Steps 8 (`uninstall_app`) and 13 (`run_installer`) require administrator privileges to execute the underlying OS commands. The agent handles this transparently in two modes:

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): both steps route through the helper and complete silently for **all users — admin and non-admin alike**. The user sees the install/uninstall succeed end-to-end. No "this requires admin" messaging is needed in the response.

**When the helper is unavailable** (`HELPER_DAEMON_ENABLED=false`, helper not installed, or helper unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`): the corrective steps deny and the diagnostic continues to completion. The diagnostic phase (Steps 1–2) and the non-destructive fixes (Steps 3–4: `reset_app_preferences` and `clear_app_cache`) still run regardless — both touch only the user's own files.

In the helper-unavailable fallback case:

1. **Don't treat the denied step as a failure.** State plainly that the agent couldn't run the install/uninstall on this device and explain why (helper unavailable / disabled / non-admin user without helper routing).
2. **Try non-destructive fixes first.** Steps 3–4 already run `reset_app_preferences` + `clear_app_cache` and gate on the user's "did that fix it?" ack before any reinstall. These resolve a meaningful share of "app crashes on launch" tickets — and they work for non-admin users without admin.
3. **Self-service path — only when Step 2 returned `enrolled: true`.** Steps 5–7 detect the catalog via `query_self_service_catalog`, deep-link via `trigger_self_service_install`, and ack the user's catalog-side install. On an unmanaged device this whole branch is absent, not merely skipped. When it did run but the steps were bypassed, point the user manually:
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
