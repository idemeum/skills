---
name: password-reset
description: Diagnoses and resolves account password issues including expired passwords, locked accounts, Active Directory binding failures, and Keychain desync after password changes. Use when user cannot log in, is prompted repeatedly for their password, or needs to reset their local account password.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - get_account_info
  - check_password_expiry
  - check_ad_binding
  - reset_local_password
  - repair_keychain
  - reset_app_preferences
  - check_filevault_status
  - check_mdm_enrollment
metadata:
  prerequisites:
    before-corrective:
      - get_account_info
      - check_password_expiry
      - check_ad_binding
  maxAggregateRisk: critical
  userLabel: "Can't log in or password problems"
  examples:
    - "I can't log in to my computer"
    - "my password has expired"
    - "I'm locked out of my account"
    - "I keep getting prompted for my password"
    - "I forgot my login password"
  pill:
    label: Reset Password
    goal: I cannot log in or my password has expired, please help me reset or fix my account password
    icon: KeyRound
    iconClass: text-purple-500
    order: 4
---

## When to use

Use this skill when the user:
- Cannot log into their Mac or Windows account
- Is repeatedly prompted for their password by apps or the OS
- Reports their password has expired or will expire soon
- Gets "authentication failed" errors in Mail, VPN, or other apps after a password change
- Reports their Keychain is locked or asking for a different password than their login password
- Asks "how do I reset my password?" or "my password stopped working"

Do NOT use this skill for VPN authentication failures specifically — use the `vpn-repair` skill. Do NOT use it for email authentication failures specifically — use the `email-repair` skill. Both may involve password issues but have additional diagnosis steps.

---

## Steps

**Step 1 — Get account information**
Call `get_account_info` to establish the baseline: current username, account type (admin/standard), home directory, and whether the machine is domain-joined. This determines whether the reset path is local or Active Directory.

**Step 2 — Check password expiry**
Call `check_password_expiry` for the current user. If the password is expired or expiring within 7 days, surface this immediately — it is the most common cause of repeated authentication prompts across all apps simultaneously.

**Step 3 — Check AD binding (if domain-joined)**
If `get_account_info` indicates the machine is domain-bound, call `check_ad_binding` to verify the AD binding is healthy. A broken AD binding causes login failures and password sync errors that cannot be resolved locally — if the binding is broken, escalate to IT to re-bind the machine.

**Step 4 — Advise on password reset path**
Based on the account type, guide the user to the appropriate reset method:

- **Local account, user knows current password**: Guide them to System Settings → Users & Groups (macOS) or Settings → Accounts (Windows) to change it directly. This is the safest path — no tool invocation needed.
- **Local account, user is locked out**: If the user cannot log in at all, they need Recovery Mode on macOS or a Windows recovery partition. The agent cannot help while the user is locked out of their session — guide them to the recovery flow.
- **Local account, user is signed in**: `reset_local_password` requires both `username` and `newPassword` as required parameters — the planner cannot omit either. Obtain the new password from the user (see security note below), then call `reset_local_password` with `username`, `newPassword`, and `dryRun: true` first to preview. If the user confirms, call again with the same parameters and `dryRun: false`. The G4 consent gate fires automatically (`requiresConsent: true`, `destructive: true`, `riskLevel: critical`, `affectedScope: ["system"]`). With the privileged helper daemon installed (default), `reset_local_password` completes for **all users — admin and non-admin alike** — the helper handles the underlying `dscl`/`net user` invocation as root/LocalSystem. No prior admin status required on the user's part. Never echo the new password back in the assistant response.

  > **Security note** — `newPassword` flows through the LLM context, the agent scratchpad, the `task_logs.tool_input` column, the outbound ticket payload, and potentially the conversation embeddings. Do NOT ask the user to type their new password directly in the chat — the value will be persisted in logs and memory. Prefer one of: (a) escalate to IT for a proper identity-provider reset; (b) generate a one-time temp password, deliver it via a secure out-of-band channel (printed on screen with a "clear chat after use" instruction), and require the user to change it on next login; (c) wait for a future UI enhancement that collects the new password via a secure input field on the consent card rather than through the chat. Until that UI exists, option (b) is the safest tool-driven path.
- **Domain account**: Password must be reset via IT helpdesk, Active Directory console, or self-service portal. This skill cannot reset AD passwords — escalate to IT.

**Step 5 — Check Keychain status (macOS)**
After any password change — or when the user reports repeated Keychain prompts — call `repair_keychain` with `action: "check"` to inspect keychain status. A desync between the login Keychain password and the account password is the most common post-reset side effect on macOS.

**Step 6 — Repair Keychain if desynced (macOS only)**
Keychain repair and reset are macOS-only concepts — on Windows, `repair_keychain` with `action: "repair"` or `action: "reset"` returns a "not applicable" result. Skip this step on Windows.

If the Keychain check reveals a lock or password mismatch:
1. Call `repair_keychain` with `action: "repair"` to attempt an unlock (despite the name, this action primarily attempts `security unlock-keychain` — it does not perform deep first-aid on the keychain file).
2. If repair fails, call `repair_keychain` with `action: "reset"` and `dryRun: true` to show what would be deleted. Warn the user that resetting the Keychain deletes all stored passwords, certificates, and Wi-Fi credentials — they will need to re-enter credentials for all apps. The G4 consent gate fires automatically on the reset path. Only proceed with `dryRun: false` if the user explicitly agrees.

**Step 7 — Clear app credential caches**
After a password change, apps that cached the old password will fail repeatedly. Guide the user to:
- Mail: remove and re-add the email account (the old password is cached in the account settings)
- VPN: the VPN client may cache credentials — advise the user to update the saved password in the VPN client directly, or run the `vpn-repair` skill if reconnection is needed
- Other apps: if repeated prompts persist, ask the user which specific app is still prompting, then call `reset_app_preferences` with `appName` set to that app's name (e.g. `appName: "Mail"`, `appName: "Slack"`, `appName: "Microsoft Outlook"`) and `dryRun: true`. The `appName` parameter is required — do not call this tool without an explicit app name supplied by the user. The G4 consent gate fires automatically before any preferences are removed (`requiresConsent: true`, `destructive: true`, `riskLevel: high`). Clearing the preferences forces the app to prompt for fresh credentials on next launch

**Step 8 — Verify login works**
Ask the user to lock their screen and log back in with the new password to confirm it works end-to-end before closing the session.

**Step 9 — Final report**
Summarise what was found (expired password, Keychain desync, broken AD binding, etc.), what was changed, and any follow-up steps the user needs to take (re-enter credentials in specific apps, contact IT for AD reset, etc.).

---

## Privilege handling — helper-routed (default) vs. fallback

Steps 4 (`reset_local_password`) and 6 (`repair_keychain` with `action: "reset"`) require administrator privileges to execute the underlying OS commands (`dscl . -passwd` on macOS, `net user` on Windows, `security delete-keychain` on macOS). The agent handles this transparently in two modes:

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): the agent routes these steps through the helper daemon and they complete silently for **all users — admin and non-admin alike**. The user sees the step succeed; the diagnosis is the corrective step. No "this requires admin" messaging is needed in the response.

**When the helper is unavailable** (`HELPER_DAEMON_ENABLED=false`, helper not installed, or helper unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`): the corrective step denies and the diagnostic continues to completion — the diagnosis itself is still the deliverable. In this fallback case, in the response:

1. **Do not present the denied step as a failure.** State plainly that the agent couldn't complete the privileged step on this device and explain why (helper unavailable / not enabled / non-admin user).
2. **Provide a self-service path the user can follow themselves.** Examples:
   - Local password reset (macOS, user signed in): System Settings → Users & Groups → click the (i) next to the user → "Change Password…"
   - Local password reset (macOS, user locked out): boot into Recovery (⌘R) → Utilities → Terminal → `resetpassword`
   - Local password reset (Windows, user signed in): Settings → Accounts → Sign-in options → Password → "Change"
   - Local password reset (Windows, user locked out): boot from a Windows recovery USB → Command Prompt → `net user <username> <newPassword>`
   - Keychain reset (macOS): Keychain Access → Preferences → "Reset My Default Keychain", then re-enter saved credentials in apps as they prompt
3. **Domain (AD) accounts** — `reset_local_password` cannot reset Active Directory passwords; direct the user to the IT helpdesk, AD self-service portal, or a Windows-bound machine where AD password change works natively (Ctrl-Alt-Delete → Change Password).
4. **Tell the user the diagnosis is being packaged for IT escalation** — the support ticket captures the account state, password-expiry status, AD-binding result, Keychain status, FileVault status, and MDM enrollment, so a tier-1 helpdesk can pick up exactly where the agent left off. IT can also investigate why the helper is unavailable on this device.

---

## Edge cases

- **User locked out of the machine entirely** — this skill cannot help a user who is fully locked out (no access to a terminal or admin account). Advise them to boot into macOS Recovery Mode (hold Cmd+R at startup) and use the Reset Password utility, or contact IT for Windows domain machines
- **FileVault complicates recovery** — on FileVault-encrypted Macs, the recovery key or an enabled FileVault user must be used to unlock the drive before the OS loads. If the user is locked out AND FileVault is on, Recovery Mode requires the FileVault recovery key. Call `check_filevault_status` proactively if this situation arises
- **AD password reset propagation delay** — after an IT-side AD password reset, the new password may take 15–30 minutes to propagate to all domain controllers. If the user tries immediately and gets "wrong password", advise them to wait before concluding the reset failed
- **Password managers** — if the user uses 1Password, Bitwarden, or a similar tool, their master password is separate from and unaffected by the OS account password. Clarify this distinction if the user conflates the two
- **Keychain reset is irreversible** — once the login Keychain is deleted, all stored passwords are gone permanently. Always confirm the user has alternative access to critical accounts (especially their Apple ID / Microsoft Account) before proceeding with a Keychain reset
- **SSO / enterprise identity** — on managed machines, the local account password may be synced to an Identity Provider (Okta, Azure AD, Jamf Connect). Changing the local password via `reset_local_password` will desync it from the IdP. Always check `check_mdm_enrollment` first — if MDM-enrolled, escalate to IT before attempting any local password reset
- **Standard vs admin account** — `reset_local_password` requires admin privileges. If the user is logged in as a standard account user, the tool will fail. Ask if an admin account is available, or escalate to IT
