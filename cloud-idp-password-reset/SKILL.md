---
name: cloud-idp-password-reset
description: Resets a user's cloud identity provider password (Okta, Microsoft Entra, Google Workspace) and cleans up stale local session state (cached credentials, browser SSO cookies, IDP agent sync, login Keychain) so the user's apps stop presenting the old password. Use when the user says "I need to reset my Okta/Entra/Google password", "I just reset my password and now Outlook/VPN/Teams keeps asking me to sign in", or similar cloud-IDP sign-in complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - open_idp_sspr_portal
  - c_request_idemeum_idp_reset
  - wait_for_user_ack
  - request_user_input
  - present_preview
  - purge_cached_credentials
  - clear_browser_sso_cookies
  - resync_idp_agent
  - repair_keychain
metadata:
  prerequisites:
    # detect_identity_provider is the only strict prereq. detect_idp_username
    # is conditional (skipped when IDP === "unknown") and Step 1a's
    # wait_for_user_ack must legally come BETWEEN them when fallback fires —
    # listing detect_idp_username here would force G2 to reject any plan
    # that inserts the IDP-picker between the two diagnostics. See the
    # cloud-idp Phase 1 (b) audit log + commit 1f08c7b for the regression
    # this guards against.
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
    order: 9
---

## When to use

Use this skill when the user wants to reset their cloud IDP password (Okta, Microsoft Entra, Google Workspace), OR when their apps keep prompting for the old password after a reset.

Do NOT use for local account password issues — use `password-reset` instead. Do NOT use for pure SSO-health checks without a reset — that's diagnostics, not this skill.

**Security boundary:** the new password is NEVER handled by the agent. The user either types it into the IDP's own web form (SSPR path) or receives a temp password out-of-band from idemeum cloud (cloud path). Do not attempt to collect the password in chat.

---

## Steps

**Step 1 — Detect the IDP**
Call `detect_identity_provider`. Returns `output.primary` (one of `okta | entra | google | unknown`) plus `output.evidence`. Used as the working IDP for all subsequent steps. When `primary !== "unknown"` Step 1a is skipped.

**Step 1a — User-selected IDP fallback**
**Condition:** only if Step 1 returned `output.primary === "unknown"` (the device isn't joined to a recognised IDP — common on personal Macs, MDM-stripped devices, fresh installs, or devices where IT manages IDP enrolment via a different agent).

Call `wait_for_user_ack` to ask the user which IDP they want to reset:

```
prompt: "Your device isn't joined to a recognised IDP. Which one do you use for your work account?"
options:
  - { id: "okta",   label: "Okta",              kind: "primary"   }
  - { id: "entra",  label: "Microsoft Entra",   kind: "secondary" }
  - { id: "google", label: "Google Workspace",  kind: "secondary" }
  - { id: "cancel", label: "Cancel",            kind: "cancel"    }
```

On `okta` / `entra` / `google` → use that value as the working IDP for all subsequent steps (substitute the user's choice for what would otherwise come from Step 1's `primary`).
On `cancel` / `timeout` → end the run cleanly; the end-of-run ticket captures the unknown-IDP outcome for IT.

**Why this exists:** the auto-detection probe is conservative (signals must be unambiguous) and returns `unknown` on devices that legitimately have an IDP-managed workforce account but no companion-app footprint. Bailing here would leave the user stuck. The user knows which IDP their org uses; one wait_for_user_ack click is cheap and recoverable.

**Step 1b — Auto-detect the IDP username**
**Condition:** only if the working IDP (from Step 1 or Step 1a) is `okta | entra | google`.

Call `detect_idp_username` with `idp` = the working IDP. Returns `{ primaryUsername: string | null, candidates: [{ username, source, confidence, tenant? }], reason? }`. Phase 1 supports Windows + Entra (via `dsregcmd /status`) and Windows + Okta (via registry). macOS / Google / and unsupported combinations return `primaryUsername: null` with a structured `reason` — never throws. This step is read-only and silent: no UI surfaces if it succeeds. Step 1c branches on the result.

**Step 1c — Confirm or capture the IDP username**
**Condition:** only if Step 1b ran.

Three branches based on `detect_idp_username`'s output:

- **`candidates.length === 1` (single auto-detected account)** — call `wait_for_user_ack` to confirm:
  ```
  prompt:  "Reset the password for {primaryUsername} ({idp})?"
  options:
    - { id: "confirm",   label: "Yes, reset {primaryUsername}", kind: "primary"   }
    - { id: "different", label: "No, a different account",       kind: "secondary" }
    - { id: "cancel",    label: "Cancel",                        kind: "cancel"    }
  ```
  On `confirm` → use `primaryUsername` as the confirmed username; proceed to Step 2.
  On `different` → fall through to the "no candidates" branch below.
  On `cancel` / `timeout` → end the run.

- **`candidates.length` is 2-4 (multi-account picker)** — call `wait_for_user_ack` with each candidate as a button:
  ```
  prompt: "Multiple {idp} accounts are configured. Which one do you want to reset?"
  options:
    - { id: "pick:{candidate[0].username}", label: "{candidate[0].username}", kind: "primary"   }
    - { id: "pick:{candidate[1].username}", label: "{candidate[1].username}", kind: "secondary" }
    - …  (one button per candidate, max 4)
    - { id: "different",                    label: "None of these",            kind: "secondary" }
    - { id: "cancel",                       label: "Cancel",                   kind: "cancel"    }
  ```
  On `pick:<username>` → extract the username from the id prefix; use as the confirmed username; proceed to Step 2.
  On `different` → fall through to the "no candidates" branch below.
  On `cancel` / `timeout` → end the run.

- **`candidates.length === 0` OR the user picked "different" in either branch above** — call `request_user_input` to capture the username. **The prompt MUST be IDP-specific** because what the cloud needs differs per IDP — Entra's Graph API needs the UPN (which may not match the email in larger orgs), Okta accepts the login string (usually email), Google accepts the primary email or alias. Substitute `{prompt}` based on Step 1's `output.primary`:

  - **`okta`** → `prompt: "What's your Okta login? (usually your email address — e.g. alice@example.com)"`
  - **`entra`** → `prompt: "What's your Microsoft sign-in address (UPN)? In most organizations this matches your email (e.g. alice@idemeum.com), but in some it ends in .onmicrosoft.com or a different work domain. If unsure, check Outlook's account settings or your IT helpdesk."`
  - **`google`** → `prompt: "What's your Google Workspace email address?"`

  Common args for all three:
  ```
  placeholder: "alice@example.com"
  validator:   "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"
  ```
  The text-input card pauses the plan; the user types and clicks Continue (or hits Enter). Returns `{ value: string }` — empty string on cancel / timeout. If `value.length === 0`, end the run. Otherwise, use `value` as the confirmed username and proceed to Step 2.

  **Why per-IDP prompts:** Entra UPN ≠ email in 5-15% of enterprise tenants (hybrid AD setups, `.onmicrosoft.com` defaults, custom UPN suffixes). The cloud's Graph API lookup is strict on UPN — passing an email alias returns "user not found" and the reset fails. The longer Entra prompt sets expectations up front rather than discovering this via a failed POST round-trip.

**Do NOT write prose like "ask the user via chat" for the username** — that pattern is functionally broken because `conversationIdRef` clears on run end (see `useAgent.ts:156`). `request_user_input` is the only mid-plan free-text mechanism that actually works.

**Step 2 — User picks reset path**
Call `wait_for_user_ack`. **The options depend on the IDP detected in Step 1 / Step 1a** — `c_request_idemeum_idp_reset` only supports Entra and Google Workspace today; Okta cloud reset is not yet enabled.

**For Entra / Google Workspace** (cloud path available — 3 buttons):

```
prompt: "How do you want to reset your {idp} password?"
options:
  - { id: "sspr",   label: "Self-service portal ({idp})",      kind: "primary"   }
  - { id: "cloud",  label: "Request reset via idemeum cloud",  kind: "secondary" }
  - { id: "cancel", label: "Cancel",                           kind: "cancel"    }
```

Mention briefly in the prompt body that the **cloud path is the right choice when the user has lost MFA access** (lost phone, no recovery email) — SSPR requires passing MFA at the IDP portal; the cloud path can deliver a reset through a recovery email configured by IT.

**For Okta** (cloud path NOT available — 2 buttons):

```
prompt: "How do you want to reset your Okta password? Note: idemeum cloud-mediated reset is not yet supported for Okta — only the self-service portal path is available. If you've lost MFA access at Okta, ask IT to reset your password directly."
options:
  - { id: "sspr",   label: "Self-service portal (Okta)",  kind: "primary" }
  - { id: "cancel", label: "Cancel",                      kind: "cancel"  }
```

Do **NOT** offer the `"cloud"` button to Okta users — Step 4's `Condition:` will refuse it anyway, but the picker must not present an option the agent cannot fulfil.

Substitute `{idp}` with the human-readable IDP name from Step 1 (`Microsoft Entra` / `Google Workspace`). On `choice === "cancel"` or `timeout`, end the run.

**Step 3 — SSPR path: open the IDP's portal**
**Condition:** only if Step 2 returned `choice === "sspr"`.

Call `open_idp_sspr_portal` with `idp` from Step 1 and `tenant` if applicable (Okta tenant slug from user; Entra directory if known). The user's default browser opens on the IDP's password-reset page — the IDP enforces MFA and recovery factors, not the agent.

**Step 4 — Cloud path: request the reset**
**Condition:** only if (a) Step 2 returned `choice === "cloud"` AND (b) Step 1's detected IDP is `"entra"` OR `"google"`. `c_request_idemeum_idp_reset` does NOT support Okta — the cloud reset is not enabled for Okta tenants today. For Okta this step MUST be skipped; Step 2's option list won't offer the `cloud` button for Okta, but this Condition is belt-and-suspenders if any future edit ever re-adds it inadvertently.

Call `c_request_idemeum_idp_reset` with `idp`, `username` (the confirmed username from Step 1c's scratchpad — already auto-detected or user-entered with email-format validation), and `tenant` if applicable. The tool's Zod schema enforces email/UPN format on `username`; G4 auto-triggers a dry-run preview (showing the exact outbound payload, with `username` redacted per the tool's `sensitiveParams` declaration) and then the consent gate. Surface the cloud's response to the user:

- **`status === "initiated"`** — explain how the reset was delivered using the fields from the response:
  - If `deliveryMethod` contains `"email"`: "A temporary password has been sent to **{notificationEmail}**."
  - If `deliveryMethod` contains `"sms"`: "A temporary password has also been sent by SMS to **{notificationPhone}**."
  - If neither `notificationEmail` nor `notificationPhone` is present: "A temporary password has been sent to your registered contact."
  Omit any field that is absent from the response. Proceed directly to Step 6 (skip Step 5 — see below). The local cleanup steps are safe to run before the user retrieves the temp password; they just clear stale cached state.
- **`status === "initiated"` with `deliveryMethod: "helpdesk-ticket"`** — the reset is queued for a human IT tech to process. The user does NOT have a new password yet. Surface the message + `ticketId` and **end the run** — cleanup would be premature.
- **`status === "failed"` / `"not-eligible"` / `"not-configured"`** — surface what the cloud reported and **end the run**. **MUST NOT call `open_idp_sspr_portal` as a fallback** even though SSPR is technically in `allowed-tools`. The user's `"cloud"` choice at Step 2 was informative — they likely cannot complete SSPR (lost MFA second factor, conditional-access policy that gates SSPR on a managed device, no recovery email configured, etc.). Falling back to SSPR ignores that signal and dumps them at a portal they probably can't pass. The cloud's failure messages all point to the correct next action ("Contact your MSP administrator" for `not-configured` / `not-eligible`; surface the cloud's reason verbatim for `failed`). Do NOT fight the cloud's verdict with a second tool call.

**Step 5 — Wait for the user to complete the reset (SSPR path only)**
**Condition:** only if Step 3 ran (SSPR path). **Do NOT run after Step 4** — the cloud path doesn't need this gate (see rationale below).

Call `wait_for_user_ack`:

```
prompt: "Did you successfully reset your password?"
options:
  - { id: "done",   label: "Yes, I reset it",      kind: "primary"   }
  - { id: "failed", label: "Reset failed",         kind: "secondary" }
  - { id: "cancel", label: "Cancel",               kind: "cancel"    }
```

If `failed`: advise the user to either try the cloud path (offer to re-run) or escalate via the ticket; end the run.
If `cancel` / `timeout`: end the run.
If `done`: proceed to Step 6.

**Why this is SSPR-only:** the SSPR path opens a browser; the agent has no way to know whether the user completed the reset, hit an MFA wall, or just closed the tab. The user's `done` reply is the only signal. The cloud path is different — the admin API call already changed the password server-side; `status: "initiated"` is direct confirmation from the cloud. The local cleanup steps in Step 7 (purge cached creds, clear browser SSO cookies, resync IDP agent, repair Keychain) only clear **stale local state** — they don't need the user to have the new password in hand. Making the cloud-path user wait at a gate before cleanup runs is friction without value; they can do cleanup while waiting for the temp-password email.

**Step 6 — Cleanup gate (present_preview card)**
**Condition:** only if (a) Step 5 returned `choice === "done"` (SSPR happy path), OR (b) Step 4 returned `status === "initiated"` with `deliveryMethod` of `"email"` or `"sms"` (cloud happy path; Step 5 is skipped).

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
- `{cleanupHeader}` — one short paragraph: "Your {idp} password is reset. Pick which local cleanup actions to run — without these, some apps may continue to use the old cached password." When Step 1's `output.primary === "entra"`, append this line about hybrid AD propagation: "If your org uses on-prem services via Entra Connect, they may lag by 15–30 minutes."
- `{idp}` — human-readable IDP name (`Okta` / `Microsoft Entra` / `Google Workspace`).
- `{credentialStore}` — `"the macOS Keychain"` on darwin or `"Windows Credential Manager"` on win32.
- `{keychainNote}` — on macOS: `"On macOS the login Keychain stays keyed to the OLD password until reset. Apps that pull credentials from Keychain (Mail.app, Slack, GitHub Desktop) keep failing. Resetting requires re-entering passwords in apps that prompt on next launch."`. On Windows: `"Not needed on Windows — Purge cached credentials already covers Credential Manager. Leave this unchecked."` (The category still renders on Windows for static-category consistency; if the user selects it anyway, Step 7's dispatch no-ops.)

Returns `{ selected: string[] }`. Empty selection → end run cleanly. Otherwise → Step 7.

**Step 7 — Execute confirmed cleanup actions**
For each id in Step 6's `selected`:

- `"purge-credentials"` → call `purge_cached_credentials` with `domains` set to the IDP-specific hostnames (Okta: `["okta.com", "<tenant>.okta.com"]`; Entra: `["microsoftonline.com", "login.microsoftonline.com", "microsoft.com"]`; Google: `["google.com", "accounts.google.com"]`). G4 auto-triggers preview + consent (tool is `high + destructive`). **Precedence (macOS):** if `repair-keychain` is also selected AND its escalation reaches `action: "reset"` (i.e. its `action: "repair"` returned `repaired === false`, so the reset below will run), SKIP this `purge_cached_credentials` call — `repair_keychain` `action: "reset"` renames the entire `login.keychain-db`, which removes the stale per-domain IDP entries `purge` targets anyway. Running both is redundant: two destructive ops + two consent prompts on the same keychain for one outcome. On Windows the two never collide (`repair_keychain` is skipped there).
- `"clear-cookies"` → call `clear_browser_sso_cookies` once per IDP cookie host (same domain list, one call per host — tool accepts a single `domain` per call). G4 auto-triggers preview + consent (`medium + destructive`). If the user's browsers are open, the preview will show 0 matches; advise them to quit the browser and retry.
- `"resync-agent"` → call `resync_idp_agent` with the detected `idp`. G4's consent gate fires; no preview (tool is `medium + non-destructive`).
- `"repair-keychain"` → **on macOS**, escalate least-destructive-first: (1) `action: "check"` — informational, surface the keychain status to the user; (2) `action: "repair"` — a non-destructive `security unlock-keychain` attempt; (3) only if step 2 returned `repaired === false`, call `action: "reset"`. G4 auto-triggers preview + consent on the reset call. **Do NOT gate on a guessed "password mismatch"** — a login-keychain↔password desync is not reliably detectable by any read-only command (`check` runs `security show-keychain-info`, which reports lock settings, not sync state); it only surfaces when an app fails to use a stored credential. The concrete `repaired` boolean from the `repair` action is the escalation signal, and G4's dry-run + consent is the final gate on the destructive reset the user opted into by selecting this category (`defaultSelected: false`). **On Windows**, skip silently — `purge-credentials` already handled Credential Manager and `repair_keychain` on Windows would scan the same store redundantly.

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
