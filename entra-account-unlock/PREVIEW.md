# Unlock a locked Entra account

**Skill:** `entra-account-unlock` · **Risk:** high · **Steps:** 6

Unlocks a Microsoft Entra ID account that was locked out after too many failed sign-in attempts, diagnosing the lockout cause using sign-in logs before clearing it.

## What it does, step by step

**Step 1.** Checks whether the account exists and is actually locked out before continuing.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Reviews recent sign-in attempts to determine whether the lockout looks like a typo or a possible attack.
_read-only_ · `c_entra_get_sign_in_logs`

**Step 3.** Asks the user to confirm unlocking the account, warning them first if suspicious activity was found.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Clears the account lockout so the user can sign in again.
_makes a change, asks permission, preview first_ · `c_entra_unlock_account`

**Step 5.** Confirms the account no longer shows as locked out.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Tells the user the account is unlocked and advises on password resets or MFA follow-up if needed.
_no tools_

## Tools it may use

`c_entra_get_user_info`, `c_entra_get_sign_in_logs`, `wait_for_user_ack`, `c_entra_unlock_account`
