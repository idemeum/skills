# Reset an Entra user's password

**Skill:** `entra-password-reset` · **Risk:** high · **Steps:** 10

Forces a password reset for a Microsoft Entra ID user via the admin Graph API, generating a temporary password that the gateway emails to the user's recovery address and the user must change on next sign-in.

## What it does, step by step

**Step 1.** Checks whether the user's device is enrolled with Microsoft Entra before continuing.
_read-only_ · `detect_identity_provider`

**Step 2.** Automatically finds the user's Microsoft Entra username.
_read-only_ · `detect_idp_username`

**Step 3.** Asks the user to confirm the correct account, offering alternatives if several match.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the user to manually provide their Entra username if it wasn't found automatically.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Verifies the account exists and has a recovery email on file before proceeding.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Reviews recent sign-in activity for signs of compromise beyond a forgotten password.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 7.** Asks the user to explicitly confirm before resetting the password.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Resets the account's password and emails a temporary one to the recovery address.
_makes a change, asks permission, preview first_ · `c_entra_reset_password`

**Step 9.** Confirms the account is in the expected state after the reset.
_read-only_ · `c_entra_get_user_info`

**Step 10.** Tells the user where to find their temporary password and what to do next.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_get_sign_in_logs`, `c_entra_reset_password`
