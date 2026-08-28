# Assign an Entra directory role

**Skill:** `entra-role-assign` · **Risk:** high · **Steps:** 9

Assigns a Microsoft Entra ID built-in directory role (e.g. Global Reader, User Administrator, Helpdesk Administrator) to a user, granting them the tenant-wide permissions associated with that role.

## What it does, step by step

**Step 1.** Checks that the user's account exists and notes whether it is currently enabled.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Asks the admin which directory role should be assigned, if not already specified.
_asks the user_ · `request_user_input`

**Step 3.** Looks up the built-in role matching the requested name and stops if none or too many match.
_read-only_ · `c_entra_find_role`

**Step 4.** Asks the admin to pick the exact role when multiple roles match the given name.
_asks the user_ · `wait_for_user_ack`

**Step 5.** Checks whether the user already holds the role and stops if so.
_read-only_ · `c_entra_get_role_assignments`

**Step 6.** Asks the admin to confirm before granting the tenant-wide role to the user.
_asks the user_ · `wait_for_user_ack`

**Step 7.** Assigns the confirmed directory role to the user's account.
_makes a change, asks permission, preview first_ · `c_entra_assign_role`

**Step 8.** Confirms the new role now appears among the user's assigned roles.
_read-only_ · `c_entra_get_role_assignments`

**Step 9.** Tells the admin the role was granted, when it takes effect, and how to make further changes.
_no tools_

## Tools it may use

`request_user_input`, `wait_for_user_ack`, `c_entra_get_user_info`, `c_entra_find_role`, `c_entra_get_role_assignments`, `c_entra_assign_role`
