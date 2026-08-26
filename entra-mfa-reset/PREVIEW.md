# Reset MFA for an Entra user

**Skill:** `entra-mfa-reset` · **Risk:** high · **Steps:** 7

Resets all MFA registration methods for a Microsoft Entra ID user so they are prompted to re-enroll on next sign-in.

## What it does, step by step

**Step 1.** Checks that the user's account exists in Entra and notes whether it is enabled.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Reports how many MFA methods are currently registered and whether setup is complete.
_read-only_ · `c_entra_get_mfa_status`

**Step 3.** Reviews recent sign-in history to confirm the issue is really MFA-related.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 4.** Asks the administrator to confirm before clearing all of the user's MFA methods.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Clears all registered MFA methods for the user in Entra.
_makes a change, asks permission, preview first_ · `c_entra_reset_mfa`

**Step 6.** Confirms that the user's MFA methods were successfully cleared.
_read-only_ · `c_entra_get_mfa_status`

**Step 7.** Explains that MFA was reset and the user must re-enroll on next sign-in.
_no tools_

## Tools it may use

`wait_for_user_ack`, `c_entra_get_user_info`, `c_entra_get_mfa_status`, `c_entra_get_sign_in_logs`, `c_entra_reset_mfa`
