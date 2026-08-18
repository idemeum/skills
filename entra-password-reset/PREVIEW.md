# Reset an Entra user's password

**Skill:** `entra-password-reset` · **Risk:** high · **Steps:** 9

Forces a password reset for a Microsoft Entra ID user via the admin Graph API, generating a temporary password that the gateway attempts to email to the user's recovery address and never returns to the agent.

## What it does, step by step

**Step 1.** Checks whether the device is enrolled with Microsoft Entra before continuing.
_read-only_ · `detect_identity_provider`

**Step 2.** Automatically looks up the user's Entra username.
_read-only_ · `detect_idp_username`

**Step 3.** Asks the user to confirm which account needs the password reset.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the user to type in their Entra username if it wasn't found automatically.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Verifies the account exists and has a recovery email on file before proceeding.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Reviews recent sign-in activity for signs of compromise before resetting the password.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 7.** Asks the user to explicitly confirm before resetting the password.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Resets the password and attempts to email a temporary one to the recovery address.
_makes a change, asks permission, preview first_ · `c_entra_reset_password`

**Step 9.** Tells the user whether the temporary password was emailed or must be obtained from IT.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_get_sign_in_logs`, `c_entra_reset_password`
