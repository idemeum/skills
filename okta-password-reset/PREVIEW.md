# Reset an Okta user's password

**Skill:** `okta-password-reset` · **Risk:** high · **Steps:** 5

Generates a temporary password for an Okta user via the Okta Admin API and expires their current password, with the gateway emailing the temporary password to the user's recovery address and returning only a delivery receipt (never the password itself).

## What it does, step by step

**Step 1.** Checks that the account exists, is active, and has a recovery email before continuing.
_read-only_ · `c_okta_get_user`

**Step 2.** Reviews current MFA enrollments to inform follow-up guidance after the reset.
_read-only_ · `c_okta_get_mfa_status`

**Step 3.** Asks the user to confirm before expiring the current password and generating a temporary one.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Expires the current password and emails a new temporary one to the recovery address.
_makes a change, asks permission, preview first_ · `c_okta_reset_password`

**Step 5.** Tells the user to check their recovery email and sign in with the temporary password immediately.
_no tools_

## Tools it may use

`c_okta_get_user`, `c_okta_get_mfa_status`, `wait_for_user_ack`, `c_okta_reset_password`
