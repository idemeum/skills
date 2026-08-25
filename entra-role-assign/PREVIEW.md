# Assign an Entra directory role

**Skill:** `entra-role-assign` · **Risk:** high · **Steps:** 9

Assigns a built-in Microsoft Entra ID directory role (e.g. Helpdesk Administrator, User Administrator, Global Reader) to a user, granting tenant-wide permissions associated with that role.

## What it does, step by step

**Step 1.** Checks that the user's account exists and notes whether it is enabled.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Asks which built-in directory role to assign to the user.
_asks the user_ · `request_user_input`

**Step 3.** Looks up the requested role name among built-in directory roles.
_read-only_ · `c_entra_find_role`

**Step 4.** Asks the user to pick the correct role from multiple matching names.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 5.** Checks whether the user already holds the role and stops if so.
_read-only_ · `c_entra_get_role_assignments`

**Step 6.** Asks for explicit confirmation before granting the tenant-wide role.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Assigns the selected directory role to the user's account.
_makes a change, asks permission, preview first_ · `c_entra_assign_role`

**Step 8.** Confirms the new role now appears in the user's assignments.
_read-only_ · `c_entra_get_role_assignments`

**Step 9.** Reports success and reminds the admin to review role assignments periodically.
_no tools_

## Tools it may use

`request_user_input`, `c_entra_get_user_info`, `c_entra_find_role`, `wait_for_user_ack`, `c_entra_get_role_assignments`, `c_entra_assign_role`
