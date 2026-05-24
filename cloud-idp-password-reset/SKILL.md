---
name: cloud-idp-password-reset
description: Resets a user's cloud identity provider password (Okta, Microsoft Entra, Google Workspace) and cleans up stale local session state (cached credentials, browser SSO cookies, IDP agent sync, login Keychain) so the user's apps stop presenting the old password. Use when the user says "I need to reset my Okta/Entra/Google password", "I just reset my password and now Outlook/VPN/Teams keeps asking me to sign in", or similar cloud-IDP sign-in complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - open_idp_sspr_portal
  - request_idemeum_idp_reset
  - wait_for_user_ack
  - present_preview
  - purge_cached_credentials
  - clear_browser_sso_cookies
  - resync_idp_agent
  - repair_keychain
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
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

Use this skill when the user wants to reset their cloud IDP password (Okta, Microsoft Entra, Google Workspace), OR when their apps keep prompting for the old password after a reset.

Do NOT use for local account password issues — use `password-reset` instead. Do NOT use for pure SSO-health checks without a reset — that's diagnostics, not this skill.

**Security boundary:** the new password is NEVER handled by the agent. The user either types it into the IDP's own web form (SSPR path) or receives a temp password out-of-band from idemeum cloud (cloud path). Do not attempt to collect the password in chat.

---

## Steps

**Step 1 — Detect the IDP**
Call `detect_identity_provider`. Returns `output.primary` (one of `okta | entra | google | unknown`) plus `output.evidence`. If `primary === "unknown"`, tell the user no supported IDP was detected and end the run — the end-of-run ticket captures the outcome for IT.

**Step 2 — User picks reset path**
Call `wait_for_user_ack` to let the user choose between the IDP's self-service portal and the idemeum cloud-mediated path:

```
prompt: "How do you want to reset your {idp} password?"
options:
  - { id: "sspr",   label: "Self-service portal ({idp})",      kind: "primary"   }
  - { id: "cloud",  label: "Request reset via idemeum cloud",  kind: "secondary" }
  - { id: "cancel", label: "Cancel",                           kind: "cancel"    }
```

Substitute `{idp}` with the human-readable IDP name from Step 1 (`Okta` / `Microsoft Entra` / `Google Workspace`). Mention briefly in the prompt body that the **cloud path is the right choice when the user has lost MFA access** (lost phone, no recovery email) — SSPR requires passing MFA at the IDP portal; the cloud path can deliver a reset through a recovery email configured by IT.

If `choice === "cancel"` or `timeout`, end the run.

**Step 3 — SSPR path: open the IDP's portal**
**Condition:** only if Step 2 returned `choice === "sspr"`.

Call `open_idp_sspr_portal` with `idp` from Step 1 and `tenant` if applicable (Okta tenant slug from user; Entra directory if known). The user's default browser opens on the IDP's password-reset page — the IDP enforces MFA and recovery factors, not the agent.

**Step 4 — Cloud path: request the reset**
**Condition:** only if Step 2 returned `choice === "cloud"`.

Call `request_idemeum_idp_reset` with `idp`, `username` (the user's IDP login — ask if not known), and `tenant` if applicable. G4 auto-triggers a dry-run preview (showing the exact outbound payload, with API key redacted) and then the consent gate. Surface the cloud's response to the user:
- `status === "initiated"` — explain how the reset was delivered (e.g. "A temp password has been emailed to your recovery address"). Include `ticketId` if returned.
- `status === "failed"` / `"not-eligible"` — surface what the cloud reported and end the run.
- `status === "not-configured"` — tell the user idemeum cloud is not enabled on this device; contact their MSP administrator. End the run.

**Step 5 — Wait for the user to complete the reset**
**Condition:** only if Step 3 or Step 4 ran.

Call `wait_for_user_ack`:

```
prompt: "Did you successfully reset your password?"
options:
  - { id: "done",   label: "Yes, I reset it",      kind: "primary"   }
  - { id: "failed", label: "Reset failed",         kind: "secondary" }
  - { id: "cancel", label: "Cancel",               kind: "cancel"    }
```

If `failed`: advise the user to either try the other reset path (offer to re-run) or escalate via the ticket; end the run.
If `cancel` / `timeout`: end the run.
If `done`: proceed to Step 6.

**Step 6 — Cleanup gate (present_preview card)**
**Condition:** only if Step 5 returned `choice === "done"`.

Call `present_preview` so the user can pick which cleanup actions to run. **The category list is fixed across every run** — only the `summary` strings are filled in from prior scratchpad output.

```yaml
title: "Post-reset cleanup"
summary: "{cleanupHeader}"
categories:
  - id: purge-credentials
    label: "Purge cached credentials"
    summary: "Remove stored {idp} passwords from {credentialStore}"
    defaultSelected: true
    destructive: true

  - id: clear-cookies
    label: "Clear browser SSO cookies"
    summary: "Sign out {idp} session in installed browsers"
    defaultSelected: true
    destructive: true

  - id: resync-agent
    label: "Resync IDP agent"
    summary: "Restart {idp}-related companion apps so cached tokens flush"
    defaultSelected: true
    destructive: false

  - id: repair-keychain
    label: "Repair login Keychain (macOS)"
    summary: "{keychainNote}"
    defaultSelected: false
    destructive: true
```

Data lineage (executor substitutes `{placeholder}` tokens at runtime):
- `{cleanupHeader}` — one short paragraph: "Your {idp} password is reset. Pick which local cleanup actions to run — without these, some apps may continue to use the old cached password." Add a line about hybrid AD propagation **only if** the IDP is `entra` AND the user mentioned on-prem services: "On-prem services may lag by 15–30 minutes via Entra Connect."
- `{idp}` — human-readable IDP name (`Okta` / `Microsoft Entra` / `Google Workspace`).
- `{credentialStore}` — `"the macOS Keychain"` on darwin or `"Windows Credential Manager"` on win32.
- `{keychainNote}` — on macOS: `"On macOS the login Keychain stays keyed to the OLD password until reset. Apps that pull credentials from Keychain (Mail.app, Slack, GitHub Desktop) keep failing. Resetting requires re-entering passwords in apps that prompt on next launch."`. On Windows: `"Not needed on Windows — Purge cached credentials already covers Credential Manager. Leave this unchecked."` (The category still renders on Windows for static-category consistency; if the user selects it anyway, Step 7's dispatch no-ops.)

Returns `{ selected: string[] }`. Empty selection → end run cleanly. Otherwise → Step 7.

**Step 7 — Execute confirmed cleanup actions**
For each id in Step 6's `selected`:

- `"purge-credentials"` → call `purge_cached_credentials` with `domains` set to the IDP-specific hostnames (Okta: `["okta.com", "<tenant>.okta.com"]`; Entra: `["microsoftonline.com", "login.microsoftonline.com", "microsoft.com"]`; Google: `["google.com", "accounts.google.com"]`). G4 auto-triggers preview + consent (tool is `high + destructive`).
- `"clear-cookies"` → call `clear_browser_sso_cookies` once per IDP cookie host (same domain list, one call per host — tool accepts a single `domain` per call). G4 auto-triggers preview + consent (`medium + destructive`). If the user's browsers are open, the preview will show 0 matches; advise them to quit the browser and retry.
- `"resync-agent"` → call `resync_idp_agent` with the detected `idp`. G4's consent gate fires; no preview (tool is `medium + non-destructive`).
- `"repair-keychain"` → **on macOS**, call `repair_keychain` with `action: "check"` first. If the result indicates a password mismatch, call `repair_keychain` with `action: "reset"`. G4 auto-triggers preview + consent on the reset call (`high + non-destructive`). **On Windows**, skip silently — `purge-credentials` already handled Credential Manager and `repair_keychain` on Windows would scan the same store redundantly.

Each corrective step declares `inputsFrom: [{ step: <step-6-index>, field: "selected" }, { step: 1, field: "primary" }]` so the executor only fires for ids in `selected` and has the IDP context available.

**Step 8 — Final guidance**
Tell the user to sign back into Outlook, their VPN, Teams, or whichever cloud-IDP-authenticated apps they use. If any app keeps prompting after a full quit-wait-relaunch cycle, the app's local token cache may still hold a stale token — recommend remove-and-re-add inside that specific app's settings. Mention the temp-password change-on-next-login if the cloud path was used. Summarise what was done.

---

## Edge cases

- **User does not know their Okta tenant slug** — ask them to open their Okta sign-in page; the prefix before `.okta.com` is the tenant. If they can't find it, use the cloud path (Step 4) which doesn't require the tenant.
- **idemeum cloud returns a helpdesk-ticket delivery method** — the reset is queued for a human tech. Do NOT proceed to cleanup (Step 6); the password hasn't changed yet. End the run with the ticket ID.
- **User has multiple browser profiles open** — `clear_browser_sso_cookies` cannot safely clear cookies while a Chromium browser is running. If preview shows 0 matches and the user says the browser is open, advise them to quit and re-run.
- **FileVault unlock password is separate** — cloud IDP resets do NOT change the macOS FileVault unlock password. The user still enters their old local password at boot until they change it via System Settings → Users & Groups.
- **Password manager entries are stale** — 1Password / Bitwarden cache the old password independently. After Step 7, advise the user to update their vault entry.
- **No IDP detected** — end the run; the end-of-run ticket captures the detection failure so IT can investigate.
