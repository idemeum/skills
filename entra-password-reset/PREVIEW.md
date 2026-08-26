# Reset an Entra user's password

**Skill:** `entra-password-reset` · **Risk:** high · **Steps:** 5

Forces a password reset for a Microsoft Entra ID user via the admin Graph API, generating a temporary password that the gateway emails to the user's recovery address (never returned to the agent). Also clears Entra Smart Lockout — a password reset is the only programmatic remedy for accounts locked after too many failed sign-in attempts.

## What it does, step by step

**Step 1.** Verifies the account exists and has a recovery email on file before continuing.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Checks recent sign-in history for lockout errors or suspicious activity.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 3.** Asks the admin to confirm the password reset before making any changes.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Resets the password and reports whether the temporary password was emailed successfully.
_makes a change, asks permission, preview first_ · `c_entra_reset_password`

**Step 5.** Tells the user how to retrieve their temporary password and confirms lockout is cleared.
_no tools_

## Tools it may use

`wait_for_user_ack`, `c_entra_get_user_info`, `c_entra_get_sign_in_logs`, `c_entra_reset_password`
