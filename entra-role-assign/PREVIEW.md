# Assign an Entra directory role

**Skill:** `entra-role-assign` · **Risk:** high · **Steps:** 9

Assigns a Microsoft Entra ID built-in directory role (e.g. Global Reader, User Administrator, Helpdesk Administrator) to a user, granting them the tenant-wide permissions associated with that role.

## What it does, step by step

**Step 1.** Checks that the user's account exists and reports whether sign-in is currently enabled.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Asks the admin for the exact name of the directory role to assign.
_asks the user_ · `request_user_input`

**Step 3.** Looks up the role name and stops if no match or too many matches are found.
_read-only_ · `c_entra_find_role`

**Step 4.** Asks the admin to pick the exact role when multiple similar matches are found.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 5.** Checks whether the user already holds the role and stops if so.
_read-only_ · `c_entra_get_role_assignments`

**Step 6.** Confirms with the admin before granting the tenant-wide role.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Assigns the confirmed role to the user and reports success or failure.
_makes a change, asks permission, preview first_ · `c_entra_assign_role`

**Step 8.** Confirms the new role now appears among the user's assigned roles.
_read-only_ · `c_entra_get_role_assignments`

**Step 9.** Reports the completed assignment and explains when the new permissions take effect.
_no tools_

## Tools it may use

`request_user_input`, `wait_for_user_ack`, `c_entra_get_user_info`, `c_entra_find_role`, `c_entra_get_role_assignments`, `c_entra_assign_role`
