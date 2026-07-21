---
name: entra-account-unlock
description: Unlocks a Microsoft Entra account that was locked out after too many failed sign-in attempts. Diagnoses the lockout cause using sign-in logs, clears the lockout state, and verifies the account is accessible again. Use when the user says "I'm locked out of my Microsoft account", "too many failed login attempts", or similar Entra account lockout complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - request_user_input
  - wait_for_user_ack
  - c_entra_get_user_info
  - c_entra_get_sign_in_logs
  - c_entra_unlock_account
  - present_preview
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
      - c_entra_get_user_info
  maxAggregateRisk: high
  userLabel: "Unlock a locked Entra account"
  examples:
    - "user is locked out of their Microsoft account"
    - "too many failed login attempts"
    - "Entra account is locked"
    - "unlock this user's Azure AD account"
    - "account lockout after wrong password"
  pill:
    label: Unlock Entra Account
    goal: I'm locked out of my Microsoft Entra account after too many failed sign-in attempts — unlock my account so I can sign in again
    icon: LockOpen
    iconClass: text-green-500
    order: 16
---

## When to use

Use this skill when a Microsoft Entra user is locked out after too many failed sign-in attempts. This skill diagnoses the lockout cause using sign-in logs, clears the lockout, and verifies the account is accessible.

Do NOT use for Okta or Google account lockouts — those require different admin APIs. Do NOT use when the account is disabled (not locked out) — that requires an admin to re-enable the account through a different process.

---

## Steps

**Step 1 — Identify the target user**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If Entra is not detected in either field, this skill is not applicable — tell the user their device is not enrolled with Microsoft Entra and suggest they create a support ticket.

If Entra is detected, call `detect_idp_username` with `idp: "entra"`.

- If `primaryUsername` is returned → confirm with the user via `wait_for_user_ack`: "Is this your Microsoft account: {primaryUsername}?"
- If `candidates` has multiple entries → present the choices via `wait_for_user_ack` and let the user pick
- If `primaryUsername` is null → call `request_user_input` asking for their Microsoft Entra UPN (explain that it may look like an email address, e.g. alice@example.com, and may differ from their personal email in hybrid AD setups)

The confirmed UPN is used as `userPrincipalName` for all subsequent tool calls.

**Step 2 — Verify lockout state**

Call `c_entra_get_user_info` with the confirmed UPN.

- If the tool returns `status: "not-configured"` → tell the user that the cloud gateway is not set up on this machine and they should contact their IT administrator
- If the tool returns `status: "failed"` with `httpStatus: 404` → the UPN was not found in Entra. Ask the user to double-check the spelling
- If `lockedOut` is `false` → inform the user their account is NOT currently locked out. The issue may be something else (wrong password, MFA failure, account disabled). If `accountEnabled` is `false`, suggest they contact their admin to re-enable the account
- If `lockedOut` is `true` → proceed with the unlock flow
- On success, note the `displayName` for user-friendly messaging

**Step 3 — Diagnose lockout cause**

Call `c_entra_get_sign_in_logs` with the confirmed UPN.

Analyze the sign-in events:
- Look for patterns of failed attempts (repeated failures from the same or different locations)
- Check if failures come from a single IP/location (likely the user's own failed attempts) or multiple diverse locations (possible brute-force attack)
- Note the error codes — common ones: 50126 (invalid credentials), 50053 (account locked), 50057 (account disabled)
- Check the timestamps — are the failures clustered in a short period?

Present the analysis to the user:
- "Your account was locked after X failed sign-in attempts between {startTime} and {endTime}"
- If all failures are from a single location/device → "This appears to be from your own sign-in attempts"
- If failures come from multiple diverse locations → "WARNING: Some sign-in attempts came from unusual locations ({locations}). This may indicate unauthorized access attempts. Consider resetting your password after unlocking."

**Step 4 — Security assessment before unlock**

If the sign-in logs show suspicious activity (multiple diverse locations, unusual devices, or patterns consistent with brute-force attacks):
- Use `wait_for_user_ack` to warn: "Sign-in logs show potentially suspicious activity from {locations}. It is recommended to reset your password after unlocking the account. Do you want to proceed with the unlock?"
- If the user confirms, proceed. Also recommend `entra-password-reset` as a follow-up action.

If the sign-in logs show normal activity (user's own failed attempts):
- Use `wait_for_user_ack` to confirm: "Unlock account for {displayName} ({upn})?"

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 5 — Preview the unlock (dry-run)**

Call `c_entra_unlock_account` with `dryRun: true`. This step's params has `dryRun` authored as `true` — G4 treats this as binding and short-circuits the dry-run gate.

Present the preview to the user showing what will happen.

**Step 6 — Execute the unlock**

Call `c_entra_unlock_account` with `dryRun: false`. This step's params has `dryRun` authored as `false` — G4 fires the consent gate automatically before execution.

- If `status` is `"ok"` → proceed to verification
- If `status` is `"failed"` → report the error message to the user

**Step 7 — Verify the unlock**

Call `c_entra_get_user_info` with the confirmed UPN to confirm the lockout has been cleared (`lockedOut` should now be `false`).

**Step 8 — Post-unlock guidance**

Tell the user:
- Their account has been unlocked and they can sign in again
- If sign-in logs showed suspicious activity, strongly recommend changing their password immediately (suggest `entra-password-reset` skill or self-service via the SSPR portal)
- If the lockout was from their own failed attempts, remind them of their current password or suggest a password reset if they've forgotten it
- Smart lockout in Entra may re-lock the account if the underlying cause (wrong cached password on a device, misconfigured app) is not resolved — help identify and fix stale cached credentials if applicable
