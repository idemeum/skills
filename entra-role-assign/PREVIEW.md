# Assign an Entra directory role

**Skill:** `entra-role-assign` · **Risk:** high · **Steps:** 13

Assigns an Entra built-in directory role (e.g. Global Administrator, User Administrator, Helpdesk Administrator) to a user, granting the tenant-wide permissions associated with that role.

## What it does, step by step

**Step 1.** Checks whether the user's device is managed through Microsoft Entra before proceeding.
_read-only_ · `detect_identity_provider`

**Step 2.** Attempts to automatically identify the target user's Entra account.
_read-only_ · `detect_idp_username`

**Step 3.** Asks the admin to confirm which account should receive the role.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the admin to manually enter the target user's Entra username.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Looks up the account to confirm it exists and is enabled.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Retrieves the user's current directory roles to check for duplicates later.
_read-only_ · `c_entra_get_role_assignments`

**Step 7.** Asks which Entra directory role should be assigned to the user.
_asks the user_ · `request_user_input`

**Step 8.** Matches the requested role name to an exact built-in Entra role.
_read-only_ · `c_entra_find_role`

**Step 9.** Confirms the exact role to assign, or reports the user already holds it.
_asks the user_ · `wait_for_user_ack`

**Step 10.** Confirms the admin wants to grant this tenant-wide role before proceeding.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 11.** Assigns the chosen directory role to the user's account.
_makes a change, asks permission, preview first_ · `c_entra_assign_role`

**Step 12.** Confirms the new role now appears on the user's account.
_read-only_ · `c_entra_get_role_assignments`

**Step 13.** Reports the outcome and reminds the admin to review roles periodically.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_get_role_assignments`, `c_entra_find_role`, `c_entra_assign_role`
