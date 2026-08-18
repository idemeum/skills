---
name: entra-password-reset
description: Forces a password reset for a Microsoft Entra ID user via the admin Graph API, generating a temporary password that the gateway attempts to email to the user's recovery address and never returns to the agent. Use when the user reports a forgotten Microsoft/Entra password, SSPR is disabled or unavailable for their Entra tenant, or an admin needs to force-reset an Entra account's password.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - wait_for_user_ack
  - request_user_input
  - c_entra_get_user_info
  - c_entra_get_sign_in_logs
  - c_entra_reset_password
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
  maxAggregateRisk: high
  userLabel: "Reset an Entra user's password"
  examples:
    - "reset this user's Microsoft Entra password"
    - "force a password reset for an Azure AD account"
    - "generate a temporary password for a new hire in Entra"
    - "SSPR is disabled for this Entra user, force reset password"
    - "user forgot their Microsoft 365 password and self-service reset isn't available"
    - "admin needs to reset an Entra account password after suspected compromise"
  pill:
    label: Reset Entra Password
    goal: I need to reset a Microsoft Entra user's password because self-service password reset is unavailable or an admin needs to force-reset it
    icon: KeyRound
    iconClass: text-red-500
    order: 21
---

## When to use

Use when a Microsoft Entra ID user needs a password reset via the admin Graph API — generates a temporary password the user must change on next sign-in, delivered by the gateway to the user's recovery email.

Appropriate for: forgotten Entra/Microsoft 365 password, SSPR disabled or failed, or admin force-reset (suspected compromise, onboarding).

Do NOT use for Okta or Google password resets. Do NOT use if the account is locked out rather than password-forgotten — use `entra-account-unlock` first. Do NOT use for MFA re-enrollment (`entra-mfa-reset`), access requests (`entra-access-request`), licensing (`entra-license-assign`), or role assignment (`entra-role-assign`).

**Precondition:** the gateway delivers the temporary password by emailing the user's recovery address (`otherMails`). If no recovery email is on file, do NOT reset — it would strand the user with a changed credential and no way to retrieve it. Always check `recoveryEmail` from `c_entra_get_user_info` first and stop if null.

**Security boundary:** the temporary password is generated entirely by the gateway; it is never returned to the agent. Never type, paste, or interpolate a password into this conversation — only confirm that a reset occurred and how (or whether) it was delivered.

---

## Steps

**Step 1 — Detect the identity provider**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If not detected, this skill does not apply — tell the user their device is not enrolled with Microsoft Entra and suggest a support ticket.

**Step 2 — Auto-discover the username**

Call `detect_idp_username` with `idp: "entra"`.

**Step 3 — Confirm the account**

Use `wait_for_user_ack` to confirm, e.g. "Is this your Microsoft account: {primaryUsername}?" If `candidates` has multiple entries, present up to 4 choices plus a "different account" escape option.

**Step 4 — Capture UPN manually**

Condition: only when Step 2 found no username, or the user chose "different account" in Step 3. Call `request_user_input` asking for their Entra UPN (may look like an email, may differ from personal email in hybrid AD setups).

**Step 5 — Verify account and recovery email**

Call `c_entra_get_user_info` with the confirmed UPN.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; reset can proceed but sign-in stays blocked until re-enabled
- `lockedOut` is `true` → note this is separate; suggest `entra-account-unlock` as a follow-up
- **`recoveryEmail` is null/empty → STOP.** Tell the user there is no recovery address on file, so the gateway has nowhere to deliver a temporary password. Do not proceed; advise adding a recovery email or contacting an admin
- On success with a valid `recoveryEmail`, note `displayName` for messaging

**Step 6 — Review recent sign-in activity**

Call `c_entra_get_sign_in_logs` with the confirmed UPN. Check for repeated failures or unusual locations suggesting compromise rather than a simply forgotten password. If found, mention it — a reset is still the right remedy.

**Step 7 — Confirm the reset**

Use `wait_for_user_ack` to confirm: "This will reset the password for {displayName} ({upn}). A temporary password will be generated and, if possible, emailed to their recovery address. They must change it on next sign-in. Proceed?" MUST get explicit confirmation.

**Step 8 — Execute the reset**

Call `c_entra_reset_password` with the confirmed UPN.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "ok"` → the password WAS changed regardless of delivery outcome; branch on `deliveryMethod`:
  - `deliveryMethod: "email"` → the temporary password was sent to `notificationEmail`; tell the user to check that inbox, including spam/junk
  - `deliveryMethod: "none"` → the password changed but could NOT be emailed; tell the user their password has changed and they must contact IT to obtain it — do NOT tell them to check any inbox

**Step 9 — Deliver guidance**

Tell the user (without stating the password itself):
- The reset succeeded for {displayName} ({upn})
- If `deliveryMethod` was `"email"` — check {notificationEmail} (including spam) for the temporary password, then change it on next sign-in
- If `deliveryMethod` was `"none"` — the password has changed but was not delivered; contact IT directly to obtain the new temporary password
- If also locked out, run `entra-account-unlock`; if MFA needs re-registration, run `entra-mfa-reset`

---

## Edge cases

- **No recovery email:** never call `c_entra_reset_password` (Step 5) — this is a hard stop, not a warning.
- **`deliveryMethod: "none"`:** the reset still succeeded — never tell the user to check an inbox in this case; direct them to contact IT for the new password.
- **Account disabled:** reset can still be issued, but sign-in remains blocked until an admin re-enables the account.
- **Account locked out:** unlocking and resetting are independent; mention `entra-account-unlock` as a separate follow-up.
- **Suspicious sign-in activity:** proceed with the reset regardless — compromise is a stronger reason to reset — but flag it to the user.