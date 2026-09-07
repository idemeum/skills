---
name: okta-mfa-reset
description: Resets all enrolled MFA factors for an Okta user so they are required to re-enroll authenticators on their next sign-in. Use when the user says "I lost my phone and can't complete Okta Verify", "reset my Okta MFA factors", "I got a new phone and need to re-enroll Okta Verify", or similar Okta-specific MFA complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - wait_for_user_ack
  - c_okta_get_user
  - c_okta_get_mfa_status
  - c_okta_reset_mfa
metadata:
  maxAggregateRisk: high
  userLabel: "Reset MFA for an Okta user"
  examples:
    - "user lost their phone and can't complete Okta Verify"
    - "reset MFA factors for an Okta account"
    - "Okta Verify push notifications aren't working anymore, need it cleared"
    - "user got a new phone and needs to re-enroll Okta MFA"
    - "I can't complete Okta multi-factor sign-in"
    - "clear enrolled authenticators for a user in Okta"
  prerequisites:
    before-corrective:
      - c_okta_get_user
  pill:
    label: Reset Okta MFA
    goal: I lost my phone or authenticator app and can't complete Okta MFA — reset my enrolled factors so I can re-enroll
    icon: ShieldOff
    iconClass: text-orange-500
    order: 25
---

## When to use

Use this skill when an Okta user cannot complete MFA (lost phone, broken Okta Verify app, new device) and needs all enrolled authenticator factors cleared so they can re-enroll on next sign-in.

Do NOT use for Entra or Google MFA issues — those require different admin APIs. Do NOT use when the user has forgotten their password or the account shows `LOCKED_OUT` (use `okta-password-reset` or `okta-account-unlock` — a locked-out account stays blocked at sign-in regardless of MFA state). Do NOT use for general account status issues unrelated to MFA. Do NOT use when the user just wants to add an additional factor without clearing existing ones — that is self-service in the Okta end-user portal.

---

## Steps

**Step 1 — Verify user account exists**

Call `c_okta_get_user`.

- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator
- If `status: "failed"` with `httpStatus: 404` → the login was not found in Okta; ask the user to double-check the spelling
- If `status: "failed"` (other) → report the error to the user and stop
- If account status (`accountStatus`) is `SUSPENDED` or `DEPROVISIONED` → warn the user MFA reset may not help until the account is reactivated
- If account status is `LOCKED_OUT` → note this is a separate issue; suggest `okta-account-unlock` as a follow-up
- On success, note `firstName`/`lastName` for user-friendly messaging

**Step 2 — Check current MFA enrollment**

Call `c_okta_get_mfa_status`.

Present the current enrollment state: number and types of enrolled factors, and whether registration is complete. If `enrollments` is empty, tell the user the reset would be a no-op and confirm they still want to proceed.

**Step 3 — Confirm the reset**

Call `wait_for_user_ack`:

```yaml
prompt: "This will remove ALL enrolled MFA factors for {firstName} {lastName} ({upn}). They will be prompted to re-enroll on next sign-in. Proceed?"
options:
  - { id: "reset",  label: "Reset MFA factors", kind: "primary" }
  - { id: "cancel", label: "Cancel",             kind: "cancel"  }
```

MUST get explicit confirmation before proceeding. Do not skip this step. On `cancel` → end the run without resetting.

**Step 4 — Execute the reset**

Call `c_okta_reset_mfa`. Condition: only if Step 3 returned `reset`.

- If `status: "ok"` → proceed to verification
- If `status: "failed"` → report the `failureReason` (and `httpStatus` if present) to the user and stop
- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator

**Step 5 — Verify the reset**

Call `c_okta_get_mfa_status` again to confirm factors are cleared (empty `enrollments` array or `registrationComplete: false`).

**Step 6 — Guide the user**

Tell the user:
- All enrolled MFA factors have been cleared
- On their next sign-in to Okta, they will be prompted to enroll a new authenticator
- They should have their new phone or preferred authenticator ready (e.g. reinstall Okta Verify)
- If they also report password or lockout problems, mention `okta-password-reset` or `okta-account-unlock` as separate follow-ups

---

## Edge cases

- **No factors enrolled:** Step 2 shows an empty `enrollments` list — the reset would be a no-op; confirm the user still wants to proceed before continuing.
- **Account suspended or deprovisioned:** flag above but do not block the reset — MFA clearing is independent of account status, though sign-in stays blocked until the account is reactivated.
- **Account locked out:** unrelated to MFA reset; mention `okta-account-unlock` as a separate follow-up rather than folding it into this flow.
- **Password issues raised alongside MFA:** mention `okta-password-reset` as a separate follow-up — this skill only clears MFA factors.