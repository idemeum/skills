# Reset MFA for an Entra user

**Skill:** `entra-mfa-reset` · **Risk:** high · **Steps:** 11

Resets all MFA registration methods for a Microsoft Entra ID user so they are prompted to re-enroll on next sign-in.

## What it does, step by step

**Step 1.** Checks whether the user's device is enrolled with Microsoft Entra before continuing.
_read-only_ · `detect_identity_provider`

**Step 2.** Automatically looks up the user's Microsoft account username.
_read-only_ · `detect_idp_username`

**Step 3.** Asks the user to confirm which Microsoft account needs the MFA reset.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the user to manually provide their Microsoft account username if it wasn't found automatically.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Verifies the user's account exists in Entra and checks its enabled and lockout status.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Checks how many MFA methods are currently registered for the user.
_read-only_ · `c_entra_get_mfa_status`

**Step 7.** Reviews recent sign-in activity to confirm the issue is really MFA-related.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 8.** Asks the user to explicitly confirm before clearing all their MFA methods.
_asks the user_ · `wait_for_user_ack`

**Step 9.** Clears all registered MFA methods for the user's account.
_makes a change, asks permission, preview first_ · `c_entra_reset_mfa`

**Step 10.** Confirms that all MFA methods have been successfully cleared.
_read-only_ · `c_entra_get_mfa_status`

**Step 11.** Explains to the user that MFA is cleared and they'll re-register at next sign-in.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_get_mfa_status`, `c_entra_get_sign_in_logs`, `c_entra_reset_mfa`
