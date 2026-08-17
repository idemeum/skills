---
name: entra-account-unlock
description: Unlocks a Microsoft Entra ID account that was locked out after too many failed sign-in attempts, diagnosing the lockout cause using sign-in logs before clearing it. Use when the user says "I'm locked out of my Microsoft account", "too many failed login attempts on Entra", or similar Entra account lockout complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - wait_for_user_ack
  - request_user_input
  - c_entra_get_user_info
  - c_entra_get_sign_in_logs
  - c_entra_unlock_account
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
  maxAggregateRisk: high
  userLabel: "Unlock a locked Entra account"
  examples:
    - "user is locked out of their Microsoft Entra account after too many bad passwords"
    - "too many failed sign-in attempts on Azure AD, account locked"
    - "Entra account shows locked out, needs to be cleared"
    - "unlock this user's Microsoft Entra account"
    - "Azure AD smart lockout triggered, user can't sign in"
    - "Entra account locked after repeated failed logins from a stale device"
  pill:
    label: Unlock Entra Account
    goal: I'm locked out of my Microsoft Entra account after too many failed sign-in attempts — unlock my account so I can sign in again
    icon: LockOpen
    iconClass: text-green-500
    order: 22
---

## When to use

Use this skill when a Microsoft Entra ID user is locked out after too many failed sign-in attempts (Entra smart lockout). This skill diagnoses the lockout cause from sign-in logs, clears the lockout, and verifies the account is accessible again.

Do NOT use for Okta or Google account lockouts — those require different admin APIs. Do NOT use when the account is disabled rather than locked out — that is a directory admin action outside this skill's scope. Do NOT use for MFA re-enrollment issues (`entra-mfa-reset`), forgotten passwords (`entra-password-reset`), missing app/group access (`entra-access-request`), licence problems (`entra-license-assign`), or role assignment requests (`entra-role-assign`).

---

## Steps

**Step 1 — Detect the identity provider**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If Entra is not detected in either field, this skill is not applicable — tell the user their device is not enrolled with Microsoft Entra and suggest they create a support ticket.

**Step 2 — Auto-discover the UPN**

Call `detect_idp_username` with `idp: "entra"`.

**Step 3 — Confirm the account**

Call `wait_for_user_ack`.

- If `primaryUsername` was returned → ask "Is this your Microsoft account: {primaryUsername}?" with Yes / No options
- If `candidates` has multiple entries → present each as an option, plus a "different account" escape option
- Include the "different account" escape option in all cases

**Step 4 — Capture the UPN manually**

Call `request_user_input` asking for their Microsoft Entra UPN (explain it may look like an email address, e.g. alice@example.com, and may differ from their personal email in hybrid AD setups). Only when Step 2 found no username, or the user chose the escape option in Step 3.

The confirmed UPN from Step 3 or Step 4 is used for all subsequent tool calls.

**Step 5 — Verify lockout state**

Call `c_entra_get_user_info` with the confirmed UPN.

- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator
- If `status: "failed"` with `httpStatus: 404` → the UPN was not found in Entra; ask the user to double-check the spelling
- If `lockedOut` is `false` → tell the user the account is NOT currently locked out. If `accountEnabled` is also `false`, the account is disabled instead and this skill does not apply — direct them to their admin
- If `lockedOut` is `true` → proceed with the unlock flow
- On success, note the `displayName` for user-friendly messaging

**Step 6 — Diagnose the lockout cause**

Call `c_entra_get_sign_in_logs` with the confirmed UPN.

Look for repeated failures from a single location/device (likely the user's own mistyped attempts) versus multiple diverse locations or IPs (possible brute-force). Note error codes and the time window of the failures.

**Step 7 — Confirm the unlock**

If sign-in logs show suspicious activity (diverse locations, unfamiliar devices), use `wait_for_user_ack` with options "Unlock and recommend password reset" / "Unlock only" / "Cancel" and warn the user about the unusual sign-in attempts.

Otherwise, use `wait_for_user_ack` to confirm: "Unlock account for {displayName} ({upn})?"

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 8 — Execute the unlock**

Call `c_entra_unlock_account` with the confirmed UPN.

- If `status` is `"ok"` → proceed to verification
- If `status` is `"failed"` → report the `failureReason` (and `httpStatus` if present) to the user and suggest retrying or filing a ticket
- If `status` is `"not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator

**Step 9 — Verify the unlock**

Call `c_entra_get_user_info` with the confirmed UPN to confirm the lockout has been cleared (`lockedOut` should now be `false`).

**Step 10 — Post-unlock guidance**

Tell the user:
- Their account has been unlocked and they can sign in again
- If sign-in logs showed suspicious activity, strongly recommend a password reset via `entra-password-reset` or self-service SSPR
- If the lockout came from their own repeated failed attempts, remind them to double-check their password, and to clear any stale cached credentials on devices before retrying
- Smart lockout may re-trigger shortly after unlock if a device keeps retrying with an old password
- If MFA also needs re-registration, mention `entra-mfa-reset` as a separate follow-up

---

## Edge cases

- **Account not locked out:** if `lockedOut` is already `false`, do not call the corrective — tell the user there is nothing to unlock; if they still cannot sign in, the cause is something else (password, MFA, or disabled account).
- **Account disabled:** if `accountEnabled` is `false` in addition to `lockedOut` being `false`, this is a directory admin action outside this skill — direct the user to their admin.
- **Suspicious sign-in activity:** proceed with the unlock regardless — the user still needs access — but flag the activity and recommend a password reset as a follow-up.
- **Lockout recurs quickly:** a device with cached stale credentials can re-trigger smart lockout almost immediately after unlock; mention this in the closing guidance.