---
name: entra-mfa-reset
description: Resets all MFA methods for a Microsoft Entra user so they are prompted to re-enroll on next sign-in. Use when the user says "I lost my phone and can't do MFA", "reset my Microsoft authenticator", "I got a new phone and need to re-register MFA", or similar Entra MFA complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - request_user_input
  - wait_for_user_ack
  - c_entra_get_user_info
  - c_entra_get_mfa_status
  - c_entra_reset_mfa
  - present_preview
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
      - c_entra_get_user_info
      - c_entra_get_mfa_status
  maxAggregateRisk: high
  userLabel: "Reset MFA for an Entra user"
  examples:
    - "user lost their phone and can't do MFA"
    - "reset MFA for a Microsoft account"
    - "authenticator app isn't working"
    - "user got a new phone and needs to re-register MFA"
    - "I can't complete Microsoft two-factor"
    - "reset MFA for alice@example.com"
  pill:
    label: Reset Entra MFA
    goal: I lost my phone or authenticator app and can't complete Microsoft Entra MFA — reset my MFA registration so I can re-enroll
    icon: ShieldOff
    iconClass: text-orange-500
    order: 14
---

## When to use

Use this skill when the user cannot complete Microsoft Entra MFA (lost phone, broken authenticator app, new device) and needs all MFA methods cleared so they can re-enroll on next sign-in.

Do NOT use for Okta or Google MFA issues — those require different admin APIs. Do NOT use when the user simply wants to add an additional MFA method without removing existing ones — that is a self-service action in the Entra portal.

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
- If `accountEnabled` is `false` → warn the user their account is disabled and MFA reset may not help until the account is re-enabled
- On success, note the `displayName` for user-friendly messaging

**Step 3 — Check current MFA status**

Call `c_entra_get_mfa_status` with the confirmed UPN.

Present the current registration state to the user:
- Number of registered methods and their types
- Which method is the default
- Whether registration is marked complete

If no MFA methods are registered, inform the user and ask if they still want to proceed (the reset would be a no-op).

**Step 4 — Confirm the reset**

Use `wait_for_user_ack` to confirm: "This will remove ALL registered MFA methods for {displayName} ({upn}). After the reset, you will be prompted to set up MFA again on your next sign-in. Do you want to proceed?"

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 5 — Preview the reset (dry-run)**

Call `c_entra_reset_mfa` with `dryRun: true`. This step's params has `dryRun` authored as `true` — G4 treats this as binding and short-circuits the dry-run gate.

Present the preview to the user showing what will happen.

**Step 6 — Execute the reset**

Call `c_entra_reset_mfa` with `dryRun: false`. This step's params has `dryRun` authored as `false` — G4 fires the consent gate automatically before execution.

- If `status` is `"ok"` → proceed to verification
- If `status` is `"failed"` → report the error message to the user

**Step 7 — Verify the reset**

Call `c_entra_get_mfa_status` with the confirmed UPN again.

Confirm that the methods have been cleared (methods array should be empty or registrationComplete should be false).

**Step 8 — Guide the user**

Tell the user:
- All MFA methods have been cleared
- On their next sign-in to any Microsoft service, they will be prompted to set up MFA again
- They should have their new phone or preferred authentication method ready
- The re-enrollment prompt will appear automatically — no additional action is needed from IT
