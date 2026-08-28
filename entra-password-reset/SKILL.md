---
name: entra-password-reset
description: Forces a password reset for a Microsoft Entra ID user via the admin Graph API, generating a temporary password that the gateway emails to the user's recovery address (never returned to the agent). Also clears Entra Smart Lockout — a password reset is the only programmatic remedy for accounts locked after too many failed sign-in attempts. Use when the user reports a forgotten Microsoft/Entra password, SSPR is disabled or unavailable, an admin needs to force-reset, or Smart Lockout has triggered.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - wait_for_user_ack
  - c_entra_get_user_info
  - c_entra_get_sign_in_logs
  - c_entra_reset_password
metadata:
  maxAggregateRisk: high
  userLabel: "Reset an Entra user's password"
  examples:
    - "reset this user's Microsoft Entra password"
    - "force a password reset for an Azure AD account"
    - "generate a temporary password for a new hire in Entra"
    - "SSPR is disabled for this Entra user, force reset password"
    - "user is locked out of their Microsoft Entra account after too many bad passwords"
    - "Entra smart lockout triggered, user can't sign in"
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
  pill:
    label: Reset Entra Password
    goal: I need to reset a Microsoft Entra user's password because self-service password reset is unavailable, an admin needs to force-reset it, or the account is locked out after too many failed sign-in attempts
    icon: KeyRound
    iconClass: text-red-500
    order: 21
---

## When to use

Use when a Microsoft Entra ID user needs a password reset via the admin Graph API — generates a temporary password the user must change on next sign-in, delivered by the gateway to the user's recovery email.

Appropriate for: forgotten Entra/Microsoft 365 password, SSPR disabled or failed, admin force-reset (suspected compromise, onboarding), or account locked out after too many failed sign-in attempts (Entra Smart Lockout). Smart Lockout has no dedicated Graph API to clear it — a password reset is the only programmatic remedy (or waiting out the lockout timer).

Do NOT use for Okta or Google password resets. Do NOT use for MFA re-enrollment (`entra-mfa-reset`), access requests (`entra-access-request`), licensing (`entra-license-assign`), or role assignment (`entra-role-assign`).

**Precondition:** the gateway delivers the temporary password by emailing the user's recovery address (`otherMails`). If no recovery email is on file, do NOT reset — it would strand the user with a changed credential and no way to retrieve it. Always check `recoveryEmail` from `c_entra_get_user_info` first and stop if null.

**Security boundary:** the temporary password is generated entirely by the gateway; it is never returned to the agent. Never type, paste, or interpolate a password into this conversation — only confirm that a reset occurred and how (or whether) it was delivered.

**`notificationEmail` is not sensitive — do not add it to `sensitiveParams`.** `c_entra_reset_password` returns it already masked by the gateway (e.g. `d***y@e***e.com`), and Step 5 requires showing it to the user so they know which inbox to check. Redacting it to `[redacted]` breaks that requirement. `recoveryEmail` (from `c_entra_get_user_info`) is the unmasked address on file and is never shown to the user — that one stays sensitive.

---

## Steps

**Step 1 — Verify account and recovery email**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; reset can proceed but sign-in stays blocked until re-enabled
- **`recoveryEmail` is null/empty → STOP.** Tell the user there is no recovery address on file, so the gateway has nowhere to deliver a temporary password. Do not proceed; advise adding a recovery email or contacting an admin
- On success with a valid `recoveryEmail`, note `displayName` for messaging

**Step 2 — Review recent sign-in activity**

Call `c_entra_get_sign_in_logs`. Check for:

- **Error code 50053 or repeated lockout failures** → the user is Smart Lockout-locked; this password reset will clear the lockout as a side effect — tell the user so
- **Unusual locations or device patterns** suggesting compromise rather than a simply forgotten password — flag it, but a reset is still the right remedy

**Step 3 — Confirm the reset**

`Condition:` only run if Step 1 returned a non-empty `recoveryEmail`.

Call `wait_for_user_ack`:

```yaml
prompt: "This will reset the password for {displayName} ({upn}). A temporary password will be generated and, if possible, emailed to their recovery address. They must change it on next sign-in. Proceed?"
options:
  - { id: "reset",  label: "Reset the password", kind: "primary" }
  - { id: "cancel", label: "Cancel",             kind: "cancel"  }
```

MUST get explicit confirmation. On `cancel` → end the run without resetting.

**Step 4 — Execute the reset**

`Condition:` only run if (a) Step 1 returned a non-empty `recoveryEmail` AND (b) Step 3 returned `reset`.

Call `c_entra_reset_password`. Do NOT author `dryRun` — the tool declares `supportsDryRun: false` and takes no parameters.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "ok"` → the password WAS changed regardless of delivery outcome; branch on `deliveryMethod`:
  - `deliveryMethod: "email"` → the temporary password was sent to `notificationEmail`; tell the user to check that inbox, including spam/junk
  - `deliveryMethod: "none"` → the password changed but could NOT be emailed; tell the user their password has changed and they must contact IT to obtain it — do NOT tell them to check any inbox

**Step 5 — Deliver guidance**

Tell the user (without stating the password itself):
- The reset succeeded for {displayName} ({upn})
- If `deliveryMethod` was `"email"` — check {notificationEmail} (including spam) for the temporary password, then change it on next sign-in
- If `deliveryMethod` was `"none"` — the password has changed but was not delivered; contact IT directly to obtain the new temporary password
- If the user was Smart Lockout-locked, confirm that the password reset has cleared the lockout — they can sign in with the new temporary password
- If MFA needs re-registration, run `entra-mfa-reset`

---

## Edge cases

- **No recovery email:** never call `c_entra_reset_password` (Step 4) — this is a hard stop, not a warning.
- **`deliveryMethod: "none"`:** the reset still succeeded — never tell the user to check an inbox in this case; direct them to contact IT for the new password.
- **Account disabled:** reset can still be issued, but sign-in remains blocked until an admin re-enables the account.
- **Account locked out (Smart Lockout):** a password reset clears the lockout counter as a side effect — tell the user the lockout will be cleared along with the password change. There is no separate "unlock" API in Microsoft Graph.
- **Suspicious sign-in activity:** proceed with the reset regardless — compromise is a stronger reason to reset — but flag it to the user.