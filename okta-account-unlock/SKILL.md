---
name: okta-account-unlock
description: Unlocks an Okta user account stuck in LOCKED_OUT status after too many failed sign-in attempts, restoring the user's ability to authenticate. Use when the user says "my Okta account is locked out", "too many failed logins on Okta", "Okta says my account is locked", or an admin needs to clear an Okta lockout.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - wait_for_user_ack
  - c_okta_get_user
  - c_okta_get_mfa_status
  - c_okta_unlock_account
metadata:
  maxAggregateRisk: high
  userLabel: "Unlock an Okta user account"
  examples:
    - "my Okta account is locked out after too many failed attempts"
    - "Okta shows LOCKED_OUT status for this user"
    - "user can't sign into Okta, account locked"
    - "unlock an Okta account for a user who got locked out"
    - "too many bad password tries on Okta, need to unlock"
    - "Okta lockout after failed MFA attempts, please unlock"
  pill:
    label: Unlock Okta Account
    goal: My Okta account is locked out after too many failed sign-in attempts — please unlock it
    icon: LockOpen
    iconClass: text-yellow-500
    order: 27
  prerequisites:
    before-corrective:
      - c_okta_get_user
---

## When to use

Use this skill when an Okta user's account is in `LOCKED_OUT` status (typically after too many failed password or MFA attempts) and needs to be cleared so the user can sign in again.

Do NOT use for Entra ID or Google Workspace lockouts — those use different admin APIs. Do NOT use when the user has simply forgotten their password (use `okta-password-reset` — a password reset does not require the account to be locked). Do NOT use for MFA re-enrollment issues where the account is not locked (use `okta-mfa-reset`). Do NOT use if the account is suspended or deprovisioned — unlock only applies to a locked-out state; other account states require a different administrative action outside this skill's scope.

---

## Steps

**Step 1 — Verify user account exists and confirm it's locked**

Call `c_okta_get_user`.

- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator
- If `status: "failed"` with `httpStatus: 404` → the login was not found in Okta; ask the user to double-check the spelling
- If `status: "failed"` (other) → report the error to the user and stop
- On success, note the display name for user-friendly messaging, then inspect the returned account state (`accountStatus`):
  - `"LOCKED_OUT"` → proceed to Step 2
  - `"ACTIVE"` → tell the user the account is not locked; unlocking would be a no-op — stop here
  - `"SUSPENDED"` or `"DEPROVISIONED"` → tell the user unlock does not apply to this state and this skill cannot help — stop here
  - `"PASSWORD_EXPIRED"` → tell the user this looks like a password issue, not a lockout; suggest `okta-password-reset` instead

**Step 2 — Check MFA enrollment**

Call `c_okta_get_mfa_status`.

Note whether enrollments look healthy. If lockout appears MFA-related (e.g. repeated failed authenticator challenges), mention `okta-mfa-reset` as a possible follow-up after unlocking.

**Step 3 — Confirm the unlock**

Call `wait_for_user_ack`:

```yaml
prompt: "This will unlock the Okta account for {displayName} ({upn}), which is currently locked out. They will be able to sign in again. Proceed?"
options:
  - { id: "unlock", label: "Unlock account", kind: "primary" }
  - { id: "cancel", label: "Cancel",         kind: "cancel"  }
```

MUST get explicit confirmation before proceeding. On `cancel` → end the run without unlocking.

**Step 4 — Execute the unlock**

Call `c_okta_unlock_account`.

- If `status` is `"ok"` → proceed to verification
- If `status` is `"failed"` → report the `failureReason` (and `httpStatus` if present) to the user and stop
- If `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine and they should contact their IT administrator

**Step 5 — Verify the unlock**

Call `c_okta_get_user` again to confirm the returned account state (`accountStatus`) has changed to `"ACTIVE"`.

**Step 6 — Guide the user**

Tell the user:
- The account for {displayName} ({upn}) is unlocked and now active
- They can sign in again immediately with their existing password
- If lockout was caused by repeated MFA failures, consider `okta-mfa-reset` as a follow-up
- If they've also forgotten their password, suggest `okta-password-reset` separately

---

## Edge cases

- **Account not actually locked (already active):** Step 1 catches this — unlock is a no-op; stop and inform the user rather than calling the corrective.
- **Account suspended or deprovisioned:** out of scope for this skill — unlock only clears a locked-out state; tell the user this skill cannot help and stop.
- **Account password-expired:** not a lockout — redirect to `okta-password-reset` instead of unlocking.
- **Repeated MFA-driven lockouts:** unlock still applies, but flag `okta-mfa-reset` as a likely necessary follow-up to prevent recurrence.