---
name: entra-password-reset
description: Forces a password reset for a Microsoft Entra user via the admin Graph API, generating a temporary password the user must change on next sign-in. Use when the user reports a forgotten password, SSPR is disabled or unavailable, or an admin needs to force-reset a user's password.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - request_user_input
  - wait_for_user_ack
  - c_entra_get_user_info
  - c_entra_reset_password
  - present_preview
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
      - c_entra_get_user_info
  maxAggregateRisk: high
  userLabel: "Reset an Entra user's password"
  examples:
    - "reset this user's Microsoft password"
    - "user forgot their Entra password and self-service isn't working"
    - "I need to force a password reset for an employee"
    - "generate a temporary password for a new hire"
  pill:
    label: Reset Entra Password
    goal: I need to reset a Microsoft Entra password because self-service password reset is unavailable or I need to force-reset a user's password
    icon: KeyRound
    iconClass: text-red-500
    order: 15
---

## When to use

Use this skill when a Microsoft Entra user needs a password reset. This generates a temporary password via the Graph API that the user must change on next sign-in.

Appropriate when:
- The user forgot their password
- SSPR is disabled for the tenant or user
- SSPR failed and the user cannot complete it
- An admin needs to force-reset the password (e.g. suspected compromise, new hire onboarding)

Do NOT use for Okta or Google password resets — those require different admin APIs and will get their own connector-specific skills.

**Security boundary:** the temporary password is displayed ONLY to the support agent. The agent MUST communicate it to the user via a secure out-of-band channel (e.g. in-person, encrypted message). NEVER display the temporary password in the chat UI summary or log it.

---

## Steps

**Step 1 — Identify the target user**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If Entra is not detected in either field, this skill is not applicable — tell the user their device is not enrolled with Microsoft Entra and suggest they create a support ticket.

If Entra is detected, call `detect_idp_username` with `idp: "entra"`.

- If `primaryUsername` is returned → confirm with the user via `wait_for_user_ack`: "Is this your Microsoft account: {primaryUsername}?"
- If `candidates` has multiple entries → present the choices via `wait_for_user_ack` and let the user pick
- If `primaryUsername` is null → call `request_user_input` asking for their Microsoft Entra UPN (explain that it may look like an email address, e.g. alice@example.com, and may differ from their personal email in hybrid AD setups)

The confirmed UPN is used as `userPrincipalName` for all subsequent tool calls.

**Step 2 — Verify user account exists**

Call `c_entra_get_user_info` with the confirmed UPN.

- If the tool returns `status: "not-configured"` → tell the user that the cloud gateway is not set up on this machine and they should contact their IT administrator
- If the tool returns `status: "failed"` with `httpStatus: 404` → the UPN was not found in Entra. Ask the user to double-check the spelling
- If `accountEnabled` is `false` → warn the user their account is disabled. A password reset can still proceed but the user won't be able to sign in until the account is re-enabled
- If `lockedOut` is `true` → inform the user that the account is also locked out. After the password reset, they may also need an account unlock (suggest `entra-account-unlock`)
- On success, note the `displayName` for user-friendly messaging

**Step 3 — Confirm the reset**

Use `wait_for_user_ack` to confirm: "This will reset the password for {displayName} ({upn}). A temporary password will be generated that the user must change on their next sign-in. Do you want to proceed?"

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 4 — Preview the reset (dry-run)**

Call `c_entra_reset_password` with `dryRun: true`. This step's params has `dryRun` authored as `true` — G4 treats this as binding and short-circuits the dry-run gate.

Present the preview to the user showing what will happen.

**Step 5 — Execute the reset**

Call `c_entra_reset_password` with `dryRun: false`. This step's params has `dryRun` authored as `false` — G4 fires the consent gate automatically before execution.

- If `status` is `"ok"` and `temporaryPassword` is present → proceed to delivery
- If `status` is `"failed"` → report the error message to the user

**Step 6 — Verify account status**

Call `c_entra_get_user_info` with the confirmed UPN to verify the account is in the expected state after the reset.

**Step 7 — Deliver the temporary password**

Present the temporary password to the support agent with clear instructions:
- The temporary password is: {temporaryPassword}
- Communicate this to the user via a SECURE out-of-band channel (in-person, encrypted message, phone call)
- Do NOT email the temporary password in plaintext
- The user MUST change this password on their next sign-in
- If the user's account was locked, they may also need an account unlock
