# Reset MFA for an Okta user

**Skill:** `okta-mfa-reset` · **Risk:** high · **Steps:** 6

Resets all enrolled MFA factors for an Okta user so they are required to re-enroll authenticators on their next sign-in.

## What it does, step by step

**Step 1.** Checks that the user's Okta account exists and flags any status issues affecting the reset.
_read-only_ · `c_okta_get_user`

**Step 2.** Reviews the user's currently enrolled authenticators before making any changes.
_read-only_ · `c_okta_get_mfa_status`

**Step 3.** Asks the administrator to confirm before removing all of the user's MFA factors.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Clears all enrolled MFA factors for the user's Okta account.
_makes a change, asks permission, preview first, conditional_ · `c_okta_reset_mfa`

**Step 5.** Confirms the user's authenticators were successfully cleared.
_read-only_ · `c_okta_get_mfa_status`

**Step 6.** Explains that factors are cleared and the user must re-enroll an authenticator at next sign-in.
_no tools_

## Tools it may use

`wait_for_user_ack`, `c_okta_get_user`, `c_okta_get_mfa_status`, `c_okta_reset_mfa`
