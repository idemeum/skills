---
name: cloud-idp-password-reset
description: Resets a user's cloud identity provider password (Okta, Microsoft Entra, Google Workspace) and cleans up stale local session state (cached credentials, browser SSO cookies, IDP agent sync) so the user's apps stop presenting the old password. Use when the user says "I need to reset my Okta/Entra/Google password", "I just reset my password and now Outlook/VPN/Teams keeps asking me to sign in", or similar cloud-IDP sign-in complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - check_mdm_enrollment
  - check_agent_heartbeat
  - probe_idp_sspr_available
  - open_idp_sspr_portal
  - request_idemeum_idp_reset
  - wait_for_user_ack
  - purge_cached_credentials
  - clear_browser_sso_cookies
  - resync_idp_agent
  - verify_sso_auth
  - repair_keychain
  - check_connectivity
  - check_certificate_expiry
  - check_password_expiry
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
      - check_mdm_enrollment
      - check_agent_heartbeat
      - probe_idp_sspr_available
  maxAggregateRisk: high
  userLabel: "Reset my Okta/Entra/Google password"
  examples:
    - "I need to reset my Okta password"
    - "reset my Microsoft password"
    - "reset my Google Workspace password"
    - "I reset my Okta password and now Outlook and VPN keep asking me to sign in"
    - "my SSO password is not working after the reset"
    - "password expires soon for my Okta account"
  pill:
    label: Reset SSO Password
    goal: I need to reset my Okta, Microsoft Entra, or Google Workspace password — OR I just reset it and now my apps (Outlook, VPN, Mail, Teams) keep asking me for the old password
    icon: KeyRound
    iconClass: text-cyan-500
    order: 10
---

## When to use

Use this skill when the user:
- Wants to reset their cloud IDP password (Okta, Microsoft Entra, Google Workspace)
- Just reset their cloud IDP password and is now getting repeated sign-in prompts from Outlook, Teams, VPN, Slack, or other apps
- Asks "why does my Okta password not work anymore?" or similar cloud-IDP sign-in failures
- Reports their cloud IDP password will expire soon and they want to reset proactively

Do NOT use this skill for local account password issues — use `password-reset` instead. Do NOT use it when the user only asks to verify SSO is working without any reset — that's pure diagnostics; use `check_connectivity` + `verify_sso_auth` directly.

The new password is NEVER handled by the agent. Either the user types it into the IDP's own web form, or idemeum cloud delivers a temp password out-of-band. This is a hard security boundary; do not attempt to collect the password in chat.

---

## Steps

**Step 1 — Detect the IDP**
Call `detect_identity_provider` (no parameters) to identify which cloud IDP the device is joined to. The tool returns `{ primary, secondary, evidence }` where `primary` is one of `okta | entra | google | unknown`. If `primary === "unknown"`, inform the user that no supported IDP was detected on this device and end the run — the end-of-run ticket will capture the outcome so IT can follow up. Do not attempt subsequent steps.

**Step 1.5 — Device-identity gate (security)**

Before attempting any password reset, confirm this device is in a healthy state for cloud-IDP work. Conditional-Access policies on most enterprise IDPs gate SSPR on "is this a compliant managed device with a current posture report?" — running the cleanup steps blind on an unmanaged or out-of-touch device leads to confusing, hard-to-diagnose downstream failures. Both checks below are user-scope diagnostics; no admin or privileged operations.

*1.5a. MDM enrollment.* Call `check_mdm_enrollment`. The tool returns `enrolled: bool` plus the management system (Jamf, Intune, JumpCloud) and enrollment evidence.

*1.5b. Management agent heartbeat.* Call `check_agent_heartbeat`. The tool reports whether the device's management agent has communicated with its cloud recently (default freshness window: 1 hour).

Branch on the combined results:

- **Both healthy** (managed + recent heartbeat) → proceed to Step 2 with confidence. Conditional-Access policies that gate SSPR on "compliant device" will recognise this device.
- **Unmanaged device** (`enrolled: false`) → tell the user this device is not enrolled in IT's management system. Recommend one of:
  1. Initiate the password reset from a managed corp device, where the IT trust chain is intact.
  2. Use the **cloud-mediated path (Step 5)** which routes through idemeum cloud's IT-trusted channel and does not depend on local-device management state.

  If the user accepts neither option, end the run cleanly — the end-of-run ticket captures the unmanaged-device finding so IT has the context.

- **Managed but stale heartbeat** (`enrolled: true`, agent heartbeat unhealthy) → warn the user the management agent is not reaching its cloud right now. Surface the heartbeat output. Conditional-Access policies may reject the SSPR with messages that look like account locks (because the device's posture report is stale, not because the account is actually locked). Recommend one of:
  1. Wait 5–10 minutes and try again — transient network issues commonly self-resolve.
  2. Escalate to IT — the ticket includes the `check_agent_heartbeat` output so IT can investigate the management agent independently.

This is a hard gate, not a soft warning. Steps 2+ assume a managed device with a current heartbeat.

**Step 2 — Probe SSPR availability**
Call `probe_idp_sspr_available` with `idp` from Step 1 and, when the user is on Okta, the tenant slug the user supplies (e.g. "acme" for `acme.okta.com`). For Entra supply the tenant directory if you know it; the tool falls back to the `common` endpoint otherwise. The result `{ available: "yes" | "no" | "unknown", evidence }` drives Step 3's branch decision.

**Step 3 — Present path choice to the user (SKILL-level branch, not a tool call)**
Based on the probe result, ask the user to choose a reset path via a `wait_for_user_ack` step with the options appropriate to the branch:

- **SSPR available (`yes`):** offer `{ id: "sspr", label: "Reset via <IDP> self-service portal (recommended)", kind: "primary" }` vs `{ id: "cloud", label: "Escalate to idemeum cloud reset", kind: "secondary" }` vs `{ id: "cancel", label: "Cancel", kind: "cancel" }`.
- **SSPR unavailable (`no`):** offer `{ id: "cloud", label: "Escalate to idemeum cloud reset", kind: "primary" }` vs `{ id: "sspr", label: "Try self-service portal anyway", kind: "secondary" }` vs `{ id: "cancel", label: "Cancel", kind: "cancel" }`.
- **SSPR unknown (Google, or probe failed):** present both paths side-by-side — `{ id: "sspr", label: "Reset via <IDP> portal" }` and `{ id: "cloud", label: "Escalate to idemeum cloud reset" }` plus `cancel`.

**If the user has lost access to their MFA second factor** (lost phone, no recovery email configured, hardware key misplaced), guide them to choose **"Escalate to idemeum cloud reset"** — the cloud path can deliver a reset via IT-configured recovery email or helpdesk handoff and does not require passing MFA at the IDP portal. The SSPR path will fail at the IDP's MFA gate if the user cannot complete the second factor.

If the user picks `cancel` or the gate times out (`choice === "timeout"`), end the run immediately — the end-of-run ticket captures the partial completion. If the user picks `sspr`, proceed to Step 4. If the user picks `cloud`, jump to Step 5.

**Step 4 — Primary SSPR path**

*4a. Open the IDP's self-service portal.* Call `open_idp_sspr_portal` with `idp` + `tenant`. The tool supports `dryRun: true`; call with `dryRun: true` first to preview the URL via the G4 dry-run gate, then with `dryRun: false` after the user confirms. The user's default browser opens on the IDP's own password-reset page — the IDP (not the agent) enforces MFA and recovery factors.

*4b. Wait for the user to return.* Call `wait_for_user_ack` with:
```
prompt:  "Did you complete the password reset in the browser?"
options: [
  { id: "done",   label: "Yes, I reset it",                kind: "primary"   },
  { id: "failed", label: "Reset failed — try idemeum cloud", kind: "secondary" },
  { id: "cancel", label: "Cancel",                          kind: "cancel"    },
]
```
Branch on the returned `choice`:
- `done` → proceed to Step 6 (post-reset cleanup).
- `failed` → proceed to Step 5 (idemeum cloud fallback).
- `cancel` / `timeout` → end the run cleanly. Do NOT execute any subsequent plan steps. The end-of-run ticket captures the outcome.

**Step 5 — Fallback idemeum cloud path**

*5a. Request the cloud reset.* Call `request_idemeum_idp_reset` with `idp`, `username` (the user's IDP login — ask if you don't know it), and `tenant` if applicable. The tool emits a G4 dry-run preview showing the exact outbound payload (with the API key redacted) — surface this to the user. After consent, the real call POSTs to idemeum cloud, which invokes the IDP's admin API using credentials the agent never sees.

Surface the cloud's response to the user:
- `status === "initiated"` — tell the user how the reset was delivered (e.g. "A temp password has been emailed to your recovery address"). Include any `ticketId` so they can reference it.
- `status === "failed"` / `"not-eligible"` — tell the user what the cloud reported and end the run cleanly.
- `status === "not-configured"` — tell the user idemeum cloud is not enabled on this machine and they should contact their MSP administrator. End the run.

*5b. Wait for the user to complete the cloud-delivered reset.* Call `wait_for_user_ack` with:
```
prompt:  "Follow the instructions from idemeum cloud (check your recovery email / SMS / helpdesk ticket). Did you successfully reset your password?"
options: [
  { id: "done",   label: "Yes, I reset it", kind: "primary"   },
  { id: "failed", label: "Reset failed",    kind: "secondary" },
  { id: "cancel", label: "Cancel",          kind: "cancel"    },
]
```
Branch on the returned `choice`:
- `done` → proceed to Step 6 (post-reset cleanup).
- `failed` / `cancel` / `timeout` → end the run cleanly. Do NOT execute any subsequent plan steps.

**Step 6 — Post-reset endpoint cleanup**
Run the following only after explicit `done` confirmation from Step 4b or 5b. Each tool emits a G4 dry-run + consent gate — run dry-run first, surface the preview, then confirm the real run.

*6a. Purge cached credentials.* Call `purge_cached_credentials` with `domains` set to the IDP-specific exact host names (NO wildcards — the tool rejects them at the schema level). Typical values:
- Okta:   `["okta.com", "<tenant>.okta.com"]`
- Entra:  `["microsoftonline.com", "login.microsoftonline.com", "microsoft.com"]`
- Google: `["google.com", "accounts.google.com"]`

*6b. Clear browser SSO cookies.* Call `clear_browser_sso_cookies` with `domain` set to the IDP's primary cookie host — use exactly one of the Step 6a domains (the tool accepts a single domain per call). Run once per IDP cookie host that matters. The dry-run returns per-browser cookie counts so the user can see how many cookies will be cleared before confirming.

*6c. Resync the IDP agent.* Call `resync_idp_agent` with the detected `idp`. This restarts Okta Verify / Company Portal / Jamf Connect so cached session tokens are flushed and the next sign-in uses the new password. Note: a few code paths inside this tool require admin (Windows Okta service stop/start; macOS Jamf Connect `launchctl kickstart system/`) and silently no-op for non-admin users via the tool's existing best-effort error handling — the user-scope paths (macOS Okta GUI restart, macOS Entra GUI restart, Windows Entra `dsregcmd /refreshprt`) cover the dominant fleets and run for everyone.

*6d. Repair the login Keychain (macOS only).* On macOS, the user's login Keychain is still keyed to the *old* password until the user signs out and back in. Apps that pull credentials from Keychain (Mail.app, Slack desktop, GitHub Desktop, many VPN clients) will continue to fail until the Keychain is repaired. Call `repair_keychain` with `action: "check"` first to detect the Keychain state. If the result indicates a password mismatch or the Keychain remains locked, call `repair_keychain` with `action: "reset"` and `dryRun: true`, present the preview, and only proceed with `dryRun: false` after explicit user confirmation. Warn the user that resetting the login Keychain will require them to re-enter passwords for apps that prompt on next launch — that is the expected behaviour and those prompts will accept the new password. Skip this step on Windows: Step 6a's `purge_cached_credentials` already handles Credential Manager.

**Step 7 — Verify IDP propagation**

*7a. IdP reachability.* Call `verify_sso_auth` with `idp` and `tenant`. This confirms the IDP's discovery and authorize endpoints are responding with healthy TLS from this device.

*7b. Token-endpoint propagation probe.* Wait approximately 30 seconds (long enough for cloud-IDP token caches to flip), then re-call `verify_sso_auth` with the same parameters. Compare the two probe results — both should report healthy reachability and the IDP-side authorisation endpoint should accept requests after the cleanup phase. This is a heuristic, not an authoritative test that the new password works; that check happens in Step 8 when the user signs back into their apps. If either probe fails, surface the failure to the user and tell them to escalate via the end-of-run ticket.

**Step 8 — Final user guidance**

Advise the user to sign back into Outlook, their VPN client, and Teams (or whatever cloud-IDP-authenticated apps they use). If those apps accept the new password without re-prompting, the reset has fully propagated.

**App-cache prompt persistence.** If any single app keeps prompting (Teams desktop, Slack desktop, and VPN clients are common offenders), the app's local token cache may still hold a stale token. Tell the user to:

1. Quit the app *fully* — `Cmd-Q` on macOS, or right-click the system-tray icon and choose Quit on Windows. Closing the window is not enough; Teams and Slack continue to run in the tray and keep their token cache hot.
2. Wait 10 seconds.
3. Relaunch the app.

This forces the app to discard its in-memory token and pull a fresh one from the IDP. If the prompt persists after a full quit-wait-relaunch cycle, the user may need to remove-and-re-add the account inside the specific app's settings — VPN clients in particular are notorious for caching credentials in their own vault that this skill cannot reach directly.

**Hybrid AD environments.** If the device is on a hybrid Entra + on-prem Active Directory setup (Step 1 evidence shows both `WorkplaceJoined: YES` and `DomainJoined: YES` from `dsregcmd`), or if the user mentions on-prem-only services (corporate file shares, on-prem VPN concentrators, internal apps that authenticate against AD directly): cloud password changes propagate to on-prem AD via Entra Connect with a **15–30 minute delay**. Cloud services (Outlook Online, Teams, OneDrive, SharePoint Online) accept the new password immediately. On-prem services may briefly continue to reject it. Advise the user to wait 15 minutes before testing on-prem services and to escalate via the end-of-run ticket if on-prem login still fails after 30 minutes.

Summarise what was done and any follow-up items (e.g. temp password must be changed on next login, FileVault unlock password unchanged, password manager entries still show the old password and need manual update).

---

## Edge cases

- **User does not know their Okta tenant slug.** Ask them to open their Okta sign-in page and read the URL — the prefix before `.okta.com` is the tenant. If they cannot locate it, try the idemeum cloud fallback path (Step 5) which does not require the tenant.
- **SSPR enabled but user cannot pass MFA.** They may have lost their second factor (phone, hardware key). The cloud fallback path (Step 5) typically delivers a reset through a recovery email configured by IT — viable when MFA is inaccessible.
- **Hybrid AD + Entra (password writeback).** Propagation from Entra to on-prem AD can take 15–30 minutes. If the user's on-prem AD login still rejects the new password after a successful cloud reset, advise them to wait and try again, or escalate via the end-of-run ticket.
- **idemeum cloud returns a helpdesk-ticket delivery method.** The reset has been queued for a human tech to process. Do not proceed to Step 6 cleanup — the user's password has not actually changed yet. End the run with a note pointing at the ticket ID.
- **User has multiple browser profiles open.** `clear_browser_sso_cookies` cannot safely clear cookies while a Chromium browser is running. If the dry-run shows non-zero matches and the user says the browser is open, advise them to quit the browser first, then re-run Step 6b.
- **FileVault unlock password is separate.** Cloud IDP password resets do NOT change the macOS FileVault unlock password. The user will still enter their old local password at boot until they change it via System Settings → Users & Groups.
- **Password manager entries are stale.** 1Password, Bitwarden, and similar tools cache the old password independently. After Step 6, advise the user to update their vault entry for the IDP.
- **No IDP detected (`primary === "unknown"`).** End the run. The end-of-run ticket will capture that the detection failed so IT can investigate whether the user's agent install is missing expected IDP companion software.
- **Gate A/B discipline.** The agent's architecture does NOT support collecting a new password from the user in chat (the value would flow through the LLM context, audit logs, and embeddings). Both reset paths are designed to route the new password out-of-band. If a future support workflow requires in-app password entry, it must be added as a secure-input UI channel — not as a chat message.
