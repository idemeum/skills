# Unlock an Okta user account

**Skill:** `okta-account-unlock` · **Risk:** high · **Steps:** 6

Unlocks an Okta user account stuck in LOCKED_OUT status after too many failed sign-in attempts, restoring the user's ability to authenticate.

## What it does, step by step

**Step 1.** Checks whether the account exists and confirms it is actually locked out before continuing.
_read-only_ · `c_okta_get_user`

**Step 2.** Reviews the user's MFA enrollment to spot possible causes of the lockout.
_read-only_ · `c_okta_get_mfa_status`

**Step 3.** Asks the user to confirm before unlocking the account.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Removes the lockout so the account can authenticate again.
_makes a change, asks permission, preview first_ · `c_okta_unlock_account`

**Step 5.** Confirms the account status has returned to active after unlocking.
_read-only_ · `c_okta_get_user`

**Step 6.** Tells the user the account is active again and suggests follow-up steps if needed.
_no tools_

## Tools it may use

`wait_for_user_ack`, `c_okta_get_user`, `c_okta_get_mfa_status`, `c_okta_unlock_account`
