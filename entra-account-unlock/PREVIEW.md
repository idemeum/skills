# Unlock a locked Entra account

**Skill:** `entra-account-unlock` · **Risk:** high · **Steps:** 10

Unlocks a Microsoft Entra ID account that was locked out after too many failed sign-in attempts, diagnosing the lockout cause using sign-in logs before clearing it.

## What it does, step by step

**Step 1.** Checks whether the device is enrolled with Microsoft Entra before continuing.
_read-only_ · `detect_identity_provider`

**Step 2.** Attempts to automatically discover the user's Microsoft account username.
_read-only_ · `detect_idp_username`

**Step 3.** Asks the user to confirm which Microsoft account needs unlocking.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the user to manually provide their Microsoft account username.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Checks whether the account is actually locked out before proceeding.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Reviews recent sign-in activity to determine what likely caused the lockout.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 7.** Confirms with the user before unlocking the account, warning if activity looks suspicious.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Unlocks the account and reports whether the unlock succeeded.
_makes a change, asks permission, preview first_ · `c_entra_unlock_account`

**Step 9.** Confirms the account lockout has actually been cleared.
_read-only_ · `c_entra_get_user_info`

**Step 10.** Tells the user the account is unlocked and gives follow-up safety recommendations.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_get_sign_in_logs`, `c_entra_unlock_account`
