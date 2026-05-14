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
  - clear_app_cache
  - reset_app_preferences
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

---

## Steps

**Step 1 — Check mail server connectivity**
Call `check_smtp_connectivity` for the user's outgoing mail server. If the user does not know the server hostname, ask them for their email provider (Gmail, Outlook/Exchange, company mail) and use the standard hostname:
- Gmail: smtp.gmail.com
- Outlook/Microsoft 365: smtp.office365.com
- iCloud: smtp.mail.me.com

Call `check_certificate_expiry` on the same hostname to rule out an expired TLS certificate as the cause.

**Step 2 — Check account configuration**
Call `check_mail_account_config` with `client: "auto"` to read the configured IMAP/SMTP settings from the installed email client. Compare server hostnames, ports, and SSL settings against known-good values for the provider. Flag any mismatches.

**Step 3 — Check client process**
Verify the email client is not hung. If Mail or Outlook appears in `get_top_consumers` output consuming high CPU or memory, that indicates a hung process rather than a configuration issue — address the process first using the `process-manager` skill.

**Step 4 — Check file permissions (macOS Mail)**
If the client is Apple Mail, call `check_mail_permissions` to verify the ~/Library/Mail directory has correct ownership and read/write access. Permission errors silently prevent Mail from syncing or writing its index.

If the tool reports permission errors, ask the user for confirmation and then re-call `check_mail_permissions` with `fix: true` to automatically restore correct ownership and read/write permissions on the affected paths. Explain that this only modifies the user's own Mail directory — it does not touch system files.

**Step 5 — Rebuild mail index (macOS Mail)**
If Mail is slow, showing incorrect message counts, or missing messages, call `rebuild_mail_index` with `dryRun: true` to show which index files would be removed. Explain to the user that Mail will quit and rebuild its index on next launch (this is safe and non-destructive — no messages are deleted). If the user confirms, call `rebuild_mail_index` with `dryRun: false`.

**Step 6 — Repair Outlook database**
If the client is Microsoft Outlook and it is crashing or showing data errors, call `repair_outlook_database` with `dryRun: true` to locate the repair tool and database files. Instruct the user to quit Outlook first. If the tool is found and the user confirms, call `repair_outlook_database` with `dryRun: false` to launch the repair utility.

**Step 7 — Clear mail cache**
If the client remains slow after index rebuild or database repair, call `clear_app_cache` with the client name (e.g. `appName: "Mail"` or `appName: "Microsoft Outlook"`) and `dryRun: true`. Show the cache size. If significant (>500 MB) and the user confirms, clear it with `dryRun: false`.

**Step 8 — Reset preferences (last resort)**
If all other steps fail and the client still misbehaves, call `reset_app_preferences` with `appName` set to the email client name (`appName: "Mail"` for Apple Mail, `appName: "Microsoft Outlook"` for Outlook) and `dryRun: true` to show which preference files would be removed. The `appName` parameter is required — the planner must infer it from the client in play. Warn the user that this resets all client settings — they will need to re-add their accounts. The G4 consent gate will fire automatically before the actual reset (`requiresConsent: true`, `destructive: true`, `riskLevel: high`). Only proceed with `dryRun: false` if the user explicitly agrees.

**Step 9 — Final verification**
After repairs, ask the user to relaunch the email client and test sending and receiving. If SMTP connectivity was the root cause and it is now reachable, the issue should be resolved. Report a summary of all steps taken and their outcomes.

---

## Graceful degradation when account or mailbox repair requires IT

Every tool in this skill operates in user space — `rebuild_mail_index`, `repair_outlook_database`, `clear_app_cache`, `reset_app_preferences`, and `check_mail_permissions` (even with `fix: true`) all touch only the user's own `~/Library/Mail` / `%LOCALAPPDATA%\Microsoft\Outlook` directories and never need admin privileges. The privileged-helper-daemon routing does not apply to this skill.

The agent still hits failure modes it cannot resolve directly when the root cause sits outside the user's own mail data:

1. **Corporate Exchange / Microsoft 365 account locked by IT** — when an account is mid-migration, MFA-suspended, or password-expired on the server side, no client-side repair recovers it. Surface this in the response and direct the user to the IT helpdesk; the SMTP / IMAP connectivity probe and certificate check from Steps 1–2 are the diagnostic IT needs.
2. **MDM-pushed mail profile blocks configuration changes** — on macOS / iOS / Windows, IT can deploy a configuration profile that pre-fills account settings and locks the user out of editing them. `check_mail_account_config` will surface the locked settings, but `reset_app_preferences` only clears the *client-side* preferences — the profile re-applies on next launch. Tell the user this is an IT-managed account and the change must be made via MDM (Jamf Self Service, Intune Company Portal) or by an IT admin.
3. **Mail directory has root-owned files** (rare, macOS — typically post-migration or post-restore): `check_mail_permissions` with `fix: true` only adjusts permissions the current user owns. If it reports paths it cannot fix, surface the offending path list and guide the user to fix it themselves: open Terminal → `sudo chown -R $USER ~/Library/Mail` → enter their login password. Do NOT attempt to run this via the agent.
4. **Outlook database corruption beyond the local repair utility** — when `repair_outlook_database` reports "could not repair", the next step is profile re-creation: Outlook → File → Account Settings → remove the account → re-add it. For Microsoft 365 / Exchange accounts this re-downloads the mailbox from the server, so no local data is lost. For POP accounts there is no server copy — escalate to IT before removing the account.
5. **Escalation packet** — the diagnostic from Steps 1–4 captures everything IT needs: SMTP reachability, certificate expiry status, configured account settings, mail-permissions output, and (where relevant) the Outlook database repair attempt. The end-of-run ticket includes all of this so a tier-1 helpdesk can pick up cleanly without further back-and-forth.

---

## Edge cases

- **Authentication failures vs connectivity failures** — `check_smtp_connectivity` tests TCP only; a successful TCP connection does not mean credentials are valid. If connectivity is fine but send/receive still fails, the issue is likely credentials or 2FA/app password configuration — guide the user through their provider's account settings
- **OAuth / modern auth** — many providers (Gmail, Microsoft 365) now require OAuth tokens rather than passwords. If the user's client was set up with a plain password, it may have stopped working due to the provider disabling basic auth. Advise them to remove and re-add the account using the client's "Sign in with Google/Microsoft" flow
- **Exchange / EWS accounts** — Outlook on macOS uses Exchange Web Services (EWS) not IMAP/SMTP. `check_mail_account_config` may not parse EWS profiles. `check_smtp_connectivity` is irrelevant for Exchange — use `check_connectivity` to the Exchange server on port 443 instead
- **Large mailbox index rebuild** — a large mailbox (100k+ messages) can take 10–60 minutes to rebuild. Warn the user before triggering `rebuild_mail_index`
- **Keychain conflicts after password change** — if the user recently changed their email password, the old credentials may be cached in the macOS Keychain causing repeated auth failures. Suggest using `repair_keychain` (from the password-reset skill) if credential prompts persist after updating the password in the email client
- **VPN required for corporate mail** — if the user's mail server is an internal Exchange server, they may need VPN connected before mail will work. Check with `check_vpn_status` if the mail server hostname is an internal address
