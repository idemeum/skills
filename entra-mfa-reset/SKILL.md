---
name: entra-mfa-reset
description: Resets all MFA registration methods for a Microsoft Entra ID user so they are prompted to re-enroll on next sign-in. Use when the user says "I lost my phone and can't do MFA", "reset my Microsoft authenticator", "I got a new phone and need to re-register MFA", or similar Entra MFA complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - wait_for_user_ack
  - request_user_input
  - c_entra_get_user_info
  - c_entra_get_mfa_status
  - c_entra_get_sign_in_logs
  - c_entra_reset_mfa
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
  maxAggregateRisk: high
  userLabel: "Reset MFA for an Entra user"
  examples:
    - "user lost their phone and can't complete Microsoft Entra MFA"
    - "reset MFA registration for a Microsoft Entra ID account"
    - "Microsoft Authenticator app isn't working anymore, need it cleared"
    - "user got a new phone and needs to re-register Entra MFA"
    - "I can't complete Microsoft two-factor sign-in on Entra"
    - "clear MFA methods for alice@example.com in Entra ID"
  pill:
    label: Reset Entra MFA
    goal: I lost my phone or authenticator app and can't complete Microsoft Entra MFA — reset my MFA registration so I can re-enroll
    icon: ShieldOff
    iconClass: text-orange-500
    order: 20
---

## When to use

Use this skill when a Microsoft Entra ID user cannot complete MFA (lost phone, broken authenticator app, new device) and needs all registered MFA methods cleared so they can re-enroll on next sign-in.

Do NOT use for Okta or Google MFA issues — those require different admin APIs. Do NOT use when the user has forgotten their password (use `entra-password-reset`) or is locked out from repeated failed attempts (use `entra-account-unlock`) — those are different root causes even though the symptom feels similar. Do NOT use for missing app/group access (`entra-access-request`), licence problems (`entra-license-assign`), or role assignment requests (`entra-role-assign`). Do NOT use when the user just wants to add an additional MFA method without clearing existing ones — that is self-service in the Entra portal.

---

## Steps

**Step 1 — Detect the identity provider**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If Entra is not detected in either field, this skill is not applicable — tell the user their device is not enrolled with Microsoft Entra and suggest they create a support ticket.

**Step 2 — Auto-discover the username**

Call `detect_idp_username` with `idp: "entra"`.

**Step 3 — Confirm the account**

Call `wait_for_user_ack`.

- If `primaryUsername` is returned → confirm: "Is this your Microsoft account: {primaryUsername}?" plus a "different account" escape option
- If `candidates` has multiple entries → present the choices (max 4 total options including the escape) and let the user pick

**Step 4 — Capture the UPN manually**

Call `request_user_input` asking for their Microsoft Entra UPN (explain it may look like an email address, e.g. alice@example.com, and may differ from their personal email in hybrid AD setups). Only when Step 2 found no username, or the user chose the escape option in Step 3.

The confirmed UPN is used for all subsequent tool calls.

**Step 5 — Verify user account exists**

Call `c_entra_get_user_info` with the confirmed UPN.

- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator
- If `status: "failed"` with `httpStatus: 404` → the UPN was not found in Entra; ask the user to double-check the spelling
- If `accountEnabled` is `false` → warn the user their account is disabled and MFA reset may not help until it is re-enabled
- If `lockedOut` is `true` → note this is a separate issue; suggest `entra-account-unlock` as a follow-up if relevant
- On success, note the `displayName` for user-friendly messaging

**Step 6 — Check current MFA status**

Call `c_entra_get_mfa_status` with the confirmed UPN.

Present the current registration state: number and types of registered methods, and whether registration is complete. If no methods are registered, tell the user the reset would be a no-op and confirm they still want to proceed.

**Step 7 — Check recent sign-in activity**

Call `c_entra_get_sign_in_logs` with the confirmed UPN.

Scan for recent MFA-related failures to confirm the complaint is consistent with an MFA problem (rather than a password or lockout issue), and note any unusual locations worth flagging to the user.

**Step 8 — Confirm the reset**

Use `wait_for_user_ack` to confirm: "This will remove ALL registered MFA methods for {displayName} ({upn}). They will be prompted to set up MFA again on next sign-in. Proceed?"

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 9 — Execute the reset**

Call `c_entra_reset_mfa` with the confirmed UPN.

- If `status` is `"ok"` → proceed to verification
- If `status` is `"failed"` → report the `failureReason` (and `httpStatus` if present) to the user and stop
- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator

**Step 10 — Verify the reset**

Call `c_entra_get_mfa_status` with the confirmed UPN again to confirm methods are cleared (empty methods array or `registrationComplete: false`).

**Step 11 — Guide the user**

Tell the user:
- All MFA methods have been cleared
- On their next sign-in to any Microsoft service, they will be prompted to set up MFA again
- They should have their new phone or preferred authentication method ready
- If they also report password or lockout problems, mention `entra-password-reset` or `entra-account-unlock` as separate follow-ups

---

## Edge cases

- **No MFA methods registered:** Step 6 shows an empty methods list — the reset would be a no-op; confirm the user still wants to proceed before continuing.
- **Account disabled:** flag in Step 5 but do not block the reset — MFA clearing is independent of `accountEnabled`, though sign-in stays blocked until re-enabled.
- **Account locked out:** unrelated to MFA reset; mention `entra-account-unlock` as a separate follow-up rather than folding it into this flow.
- **Suspicious sign-in activity in logs:** proceed with the reset regardless, but flag it to the user as it may warrant a password reset too.