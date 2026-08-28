# Reset an Entra user's password

**Skill:** `entra-password-reset` · **Risk:** high · **Steps:** 5

Forces a password reset for a Microsoft Entra ID user via the admin Graph API, generating a temporary password that the gateway emails to the user's recovery address (never returned to the agent). Also clears Entra Smart Lockout — a password reset is the only programmatic remedy for accounts locked after too many failed sign-in attempts.

## What it does, step by step

**Step 1.** Checks that the account exists and has a recovery email on file before continuing.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Reviews recent sign-in activity to detect Smart Lockout or signs of a compromised account.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 3.** Asks the admin to confirm before resetting the user's password.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Resets the password and reports whether the temporary password was emailed or must be obtained from IT.
_makes a change, asks permission_ · `c_entra_reset_password`

**Step 5.** Explains the reset outcome, delivery details, and lockout status to the user.
_no tools_

## Tools it may use

`wait_for_user_ack`, `c_entra_get_user_info`, `c_entra_get_sign_in_logs`, `c_entra_reset_password`
