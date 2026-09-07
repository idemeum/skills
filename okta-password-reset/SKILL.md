---
name: okta-password-reset
description: Generates a temporary password for an Okta user via the Okta Admin API and expires their current password, with the gateway emailing the temporary password to the user's recovery address and returning only a delivery receipt (never the password itself). Use when a user forgot their Okta password, self-service reset (SSPR) is unavailable, or an admin needs to force-reset an Okta account.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - c_okta_get_user
  - c_okta_get_mfa_status
  - wait_for_user_ack
  - c_okta_reset_password
metadata:
  maxAggregateRisk: high
  userLabel: "Reset an Okta user's password"
  examples:
    - "reset this user's Okta password"
    - "force a password reset for an Okta account"
    - "generate a temporary Okta password for a new hire"
    - "Okta self-service password reset isn't working, force reset it"
    - "user forgot their Okta password and needs a temporary one"
    - "admin needs to reset an Okta account password after suspected compromise"
  prerequisites:
    before-corrective:
      - c_okta_get_user
  pill:
    label: Reset Okta Password
    goal: I need to reset an Okta user's password because they forgot it or self-service reset is unavailable
    icon: KeyRound
    iconClass: text-red-500
    order: 26
---

## When to use

Use when an Okta user needs a password reset via the Okta Admin API — generates a temporary password and expires the current one, delivered by the gateway to the user's recovery email.

Appropriate for: forgotten Okta password, SSPR disabled or failed, or an admin force-reset (suspected compromise, onboarding). This skill does not clear Okta lockout state — see `okta-account-unlock` for locked-out accounts. It also does not touch MFA enrollments — see `okta-mfa-reset` for authenticator problems.

Do NOT use for Entra or Google password resets. Do NOT use for account unlock (`okta-account-unlock`) or MFA re-enrollment (`okta-mfa-reset`).

**Precondition:** the gateway delivers the temporary password by emailing the user's recovery address. If no email is on file, do NOT reset — it would strand the user with a changed credential and no way to retrieve it. Always check the `email` field from `c_okta_get_user` first and stop if it is empty.

**Security boundary:** the temporary password is generated entirely by the gateway and never returned to the agent. Never type, paste, or interpolate a password into this conversation — only confirm that a reset occurred and how it was delivered.

---

## Steps

**Step 1 — Verify user account exists, check state, and check recovery email**

Call `c_okta_get_user`.

- `status: "not-configured"` → tell the user the gateway isn't set up on this machine; contact IT admin
- `status: "failed"` with `httpStatus: 404` → the login was not found in Okta; ask the user to double-check the spelling
- `status: "failed"` (other) → report the error to the user and stop
- On success, note the display name for user-friendly messaging, then inspect the returned account state (`accountStatus`) and `email`:
  - If the account is locked out → tell the user `okta-account-unlock` is the correct fix for that and stop
  - If the account is suspended → warn the user a password reset may not restore sign-in until an admin reactivates the account
  - **No recovery email on file → STOP.** There is no address for the gateway to deliver a temporary password to. Advise the user to add a recovery email or contact an admin
  - Otherwise, note the account is active and proceed

**Step 2 — Check MFA enrollment**

Call `c_okta_get_mfa_status`.

Note registered authenticator types purely for messaging — if enrollments look stale or missing, mention `okta-mfa-reset` as a possible follow-up after the password is restored.

**Step 3 — Confirm the reset**

Call `wait_for_user_ack`:

```yaml
prompt: "This will expire the current password for {displayName} ({profileLogin}) and generate a temporary password, emailed to their recovery address. Proceed?"
options:
  - { id: "reset",  label: "Reset the password", kind: "primary" }
  - { id: "cancel", label: "Cancel",             kind: "cancel"  }
```

MUST get explicit confirmation before proceeding. On `cancel` → end the run without resetting.

**Step 4 — Execute the reset**

Call `c_okta_reset_password`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "ok"` → the password was expired and a temporary one was generated and emailed; proceed to guidance

**Step 5 — Guide the user**

Tell the user (without stating the password itself):
- The reset succeeded for {displayName} ({profileLogin})
- Check the recovery email address on file (including spam/junk) for the temporary password
- They must sign in with the temporary password and set a new one immediately
- If MFA needs re-registration, run `okta-mfa-reset` as a separate follow-up
- If the account is locked out, use `okta-account-unlock` instead — this reset does not clear lockout state

---

## Edge cases

- **No recovery email on file:** never call `c_okta_reset_password` (Step 4) — this is a hard stop, not a warning.
- **Account locked out:** redirect to `okta-account-unlock`; a password reset is not the correct remedy here.
- **Account suspended:** the reset can still be issued, but sign-in remains blocked until an admin reactivates the account — say so.
- **Stale or missing MFA enrollments:** proceed with the password reset regardless; mention `okta-mfa-reset` as a separate follow-up.