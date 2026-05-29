---
name: email-repair
description: Diagnoses and repairs email client issues including account configuration, index corruption, database errors, SMTP/IMAP connectivity failures, and permission problems. Use when user reports email not sending, not receiving, missing messages, or client crashes.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_smtp_connectivity
  - check_certificate_expiry
  - check_mail_account_config
  - get_top_consumers
  - check_mail_permissions
  - rebuild_mail_index
  - repair_outlook_database
  - reset_app_preferences
  - wait_for_user_ack
  - request_user_input
metadata:
  prerequisites:
    before-corrective:
      - check_smtp_connectivity
      - check_certificate_expiry
      - check_mail_account_config
      - get_top_consumers
      - check_mail_permissions
  maxAggregateRisk: high
  userLabel: "Email not working"
  examples:
    - "my email is not sending or receiving"
    - "my email app keeps crashing"
    - "I can't access my email"
    - "Outlook keeps freezing"
    - "email stopped working this morning"
  pill:
    label: Fix Email
    goal: My email is not working, please diagnose and fix the issue
    icon: Mail
    iconClass: text-blue-500
    order: 2
---

## When to use

Use this skill when the user:
- Cannot send or receive email
- Reports their email client (Mail, Outlook) is crashing or hanging
- Sees messages missing, duplicated, or out of order
- Gets repeated password prompts or authentication failures
- Reports "cannot connect to server" or "server not responding" errors
- Asks "why is my email not working?" or "my Outlook keeps crashing"

Do NOT use this skill for general internet connectivity issues — use the `network-reset` skill first if the user has no internet access at all.

This skill follows a **diagnostic-driven escalation** pattern. Steps 1 and 1a capture the SMTP hostname (skipped if the goal already supplied it). The agent then runs all read-only diagnostics (Steps 2–5), escalates corrective actions from lightest (rebuild index) to most destructive (reset preferences), and closes with an out-of-band user-ack (Step 9). G4's per-tool dry-run preview + consent gates fire before every destructive action; the user can abort mid-escalation.

---

## Steps

**Step 1 — Pick the email provider (to derive the SMTP hostname)**
Call `wait_for_user_ack` to identify the user's email provider — Step 2's `check_smtp_connectivity` needs an SMTP hostname, and the user's choice maps directly to a known-good hostname for the common providers:

```yaml
prompt: "Which email provider does the affected account use? This tells me which mail server to test."
options:
  - { id: "gmail",     label: "Gmail",                       kind: "primary" }
  - { id: "office365", label: "Outlook / Microsoft 365",     kind: "primary" }
  - { id: "icloud",    label: "iCloud",                      kind: "secondary" }
  - { id: "other",     label: "Company / Other / Don't know", kind: "secondary" }
```

Hostname mapping (applied in Step 2):
- `gmail` → `smtp.gmail.com`
- `office365` → `smtp.office365.com`
- `icloud` → `smtp.mail.me.com`
- `other` → falls through to Step 1a's `request_user_input` capture

`Condition:` only run if the user's goal does NOT already contain an SMTP hostname / email-provider name (planner can map directly without invoking this gate). Skip silently otherwise — Step 2 uses the goal-provided value.

**Step 1a — Capture custom SMTP hostname (fallback for "other")**
Call `request_user_input` to capture a custom SMTP hostname when Step 1 returned `other`:

```yaml
prompt: "What's your outgoing mail server (SMTP) hostname? You can find this in your email client's account settings, or by checking your email provider's documentation."
placeholder: "smtp.acme.com"
validator: "^[A-Za-z0-9.\\-]+$"
```

`inputsFrom: [{ step: 1, field: "choice" }]` — only invoke when Step 1's `choice === "other"`.

`Condition:` only run if Step 1 ran AND returned `choice === "other"`. Skip silently for the gmail / office365 / icloud branches (Step 2 uses the mapped hostname directly).

If the user submits an empty value (cancel / timeout), end the run with a polite "I can't test mail-server connectivity without a hostname — try restarting your email client or contacting IT". Step 2 onward all transitively depend on having a hostname, so the rest of the flow is dead without it.

**Step 2 — Check mail server connectivity**
Call `check_smtp_connectivity` with the SMTP hostname resolved above. Then call `check_certificate_expiry` on the same hostname to rule out an expired TLS certificate as the cause.

`inputsFrom:`
- If Step 1's `choice ∈ {gmail, office365, icloud}`: pass the corresponding mapped hostname (gmail → `smtp.gmail.com`, etc.).
- If Step 1's `choice === "other"`: `inputsFrom: [{ step: 1a, field: "value" }]`.
- If Step 1 was skipped (goal had hostname): pass the goal-provided value.

**Step 3 — Check account configuration**
Call `check_mail_account_config` with `client: "auto"` to read the configured IMAP/SMTP settings from the installed email client. Returns `output.client` (detected client: `"mail"` | `"outlook"` | `"unknown"`) and `output.accounts: [{ email, imapServer, smtpServer, port, ssl }]`. Compare server hostnames, ports, and SSL settings against known-good values for the provider. Flag any mismatches in the response.

**Step 4 — Check client process**
Call `get_top_consumers` with `metric: "combined"` and `limit: 10`. Verify the email client is not hung — check if `output.processes` contains a process named `Mail`, `Microsoft Outlook`, or `Outlook` with `cpuPercent > 20` OR `memoryMb > 500`. If so, the hung process is the root cause, not a configuration issue — surface this in the response and direct the user to the `process-manager` skill instead of continuing with email-repair correctives.

**Step 5 — Check file permissions (macOS Mail only)**
**Condition:** only if Step 3 returned `output.client === "mail"` (Apple Mail).

Call `check_mail_permissions` (read-only mode). Returns `output.errors[]` listing any paths in `~/Library/Mail` with wrong ownership or missing read/write access. Permission errors silently prevent Mail from syncing or writing its index.

**Step 5b — Fix mail permissions**
**Condition:** only if Step 5 ran AND `output.errors.length > 0`.

Re-call `check_mail_permissions` with `fix: true` to restore correct ownership and read/write permissions on the affected paths. Explain in the response that this only modifies the user's own Mail directory — it does not touch system files.

**Step 6 — Rebuild mail index**
**Condition:** only if (a) Step 3 returned `output.client === "mail"` (Apple Mail) AND (b) the user reports Mail is slow, showing wrong message counts, or missing messages, OR Step 5b ran (permission fix often warrants an index rebuild).

Call `rebuild_mail_index`. G4 auto-triggers a dry-run preview gate (showing which envelope index files would be removed) followed by the consent gate. Explain in the response that Mail will quit and rebuild its index on next launch — this is safe and non-destructive in user terms (no messages are deleted; the index regenerates from the message store on next launch).

**Step 7 — Repair Outlook database**
**Condition:** only if (a) Step 3 returned `output.client === "outlook"` (Microsoft Outlook) AND (b) the user reports Outlook crashing or showing data errors.

Call `repair_outlook_database`. G4 auto-triggers the dry-run preview gate (locating the repair tool + database files) followed by the consent gate. Instruct the user in the response to quit Outlook before confirming.

**Step 8 — Reset preferences (last resort)**
**Condition:** only if (a) Steps 6 or 7 ran AND the user reports the client still misbehaves after those repairs, OR (b) the user explicitly asked to reset client preferences.

Call `reset_app_preferences` with `appName` set to the email client name (`appName: "Mail"` for Apple Mail, `appName: "Microsoft Outlook"` for Outlook — `appName` is required, infer it from Step 3's `output.client`). G4 auto-triggers the dry-run preview gate (listing which preference files would be removed) followed by the consent gate. Warn the user clearly in the response: this resets all client settings and they will need to re-add their accounts.

**Step 9 — Verify the user can send and receive**
**Condition:** only if any corrective step (5b, 6, 7, or 8) ran. Skip if only diagnostics ran (the SMTP-connectivity-only success case is self-explanatory and needs no user-side test).

The corrective steps trigger user-visible work (Mail quit + relaunch + index rebuild on next launch, Outlook database repair, preferences reset + account re-add). Whether the actual issue resolved is only observable from the user's end. Call `wait_for_user_ack` to wait for that confirmation:

```yaml
prompt: "Relaunch your email client and try sending or receiving a message. Let me know whether email is working now."
options:
  - { id: "works",        label: "Email is working",          kind: "primary" }
  - { id: "still-broken", label: "Still not working",         kind: "secondary" }
  - { id: "skip",         label: "Skip — I'll test later",    kind: "cancel" }
```

On `works`: report success and end the run. On `still-broken`: the in-scope correctives have exhausted; surface the diagnostic packet for IT escalation (see "Graceful degradation" below). On `skip`: close with "diagnostics complete; user will verify later".

**Step 10 — Final report**
Report a summary of all steps that ran, their outcomes, and any IT-escalation recommendations.

---

## Graceful degradation when account or mailbox repair requires IT

Every tool in this skill operates in user space — `rebuild_mail_index`, `repair_outlook_database`, `reset_app_preferences`, and `check_mail_permissions` (even with `fix: true`) all touch only the user's own `~/Library/Mail` / `%LOCALAPPDATA%\Microsoft\Outlook` directories and never need admin privileges. The privileged-helper-daemon routing does not apply to this skill.

The agent still hits failure modes it cannot resolve directly when the root cause sits outside the user's own mail data:

1. **Corporate Exchange / Microsoft 365 account locked by IT** — when an account is mid-migration, MFA-suspended, or password-expired on the server side, no client-side repair recovers it. Surface this in the response and direct the user to the IT helpdesk; the SMTP / IMAP connectivity probe and certificate check from Step 2 are the diagnostic IT needs.
2. **MDM-pushed mail profile blocks configuration changes** — on macOS / iOS / Windows, IT can deploy a configuration profile that pre-fills account settings and locks the user out of editing them. `check_mail_account_config` will surface the locked settings, but `reset_app_preferences` only clears the *client-side* preferences — the profile re-applies on next launch. Tell the user this is an IT-managed account and the change must be made via MDM (Jamf Self Service, Intune Company Portal) or by an IT admin.
3. **Mail directory has root-owned files** (rare, macOS — typically post-migration or post-restore): `check_mail_permissions` with `fix: true` only adjusts permissions the current user owns. If it reports paths it cannot fix, surface the offending path list and guide the user to fix it themselves: open Terminal → `sudo chown -R $USER ~/Library/Mail` → enter their login password. Do NOT attempt to run this via the agent.
4. **Outlook database corruption beyond the local repair utility** — when `repair_outlook_database` reports "could not repair", the next step is profile re-creation: Outlook → File → Account Settings → remove the account → re-add it. For Microsoft 365 / Exchange accounts this re-downloads the mailbox from the server, so no local data is lost. For POP accounts there is no server copy — escalate to IT before removing the account.
5. **Escalation packet** — the diagnostic from Steps 2–5 captures everything IT needs: SMTP reachability, certificate expiry status, configured account settings, mail-permissions output, and (where relevant) the Outlook database repair attempt. The end-of-run ticket includes all of this so a tier-1 helpdesk can pick up cleanly without further back-and-forth.

---

## Edge cases

- **Authentication failures vs connectivity failures** — `check_smtp_connectivity` tests TCP only; a successful TCP connection does not mean credentials are valid. If connectivity is fine but send/receive still fails, the issue is likely credentials or 2FA/app password configuration — guide the user through their provider's account settings
- **OAuth / modern auth** — many providers (Gmail, Microsoft 365) now require OAuth tokens rather than passwords. If the user's client was set up with a plain password, it may have stopped working due to the provider disabling basic auth. Advise them to remove and re-add the account using the client's "Sign in with Google/Microsoft" flow
- **Exchange / EWS accounts** — Outlook on macOS uses Exchange Web Services (EWS) not IMAP/SMTP. `check_mail_account_config` may not parse EWS profiles. `check_smtp_connectivity` is irrelevant for Exchange — use `check_connectivity` to the Exchange server on port 443 instead
- **Large mailbox index rebuild** — a large mailbox (100k+ messages) can take 10–60 minutes to rebuild. Warn the user before triggering Step 6 / `rebuild_mail_index`
- **Keychain conflicts after password change** — if the user recently changed their email password, the old credentials may be cached in the macOS Keychain causing repeated auth failures. The `cloud-idp-password-reset` skill includes a Keychain repair step in its post-reset cleanup; route there if the user's password change was via Okta / Entra / Google. For other password changes, advise the user to open Keychain Access → search for the mail server hostname → delete the stale entry → relaunch the mail client and re-authenticate
- **VPN required for corporate mail** — if the user's mail server is an internal Exchange server, they may need VPN connected before mail will work. Check with `check_vpn_status` if the mail server hostname is an internal address
