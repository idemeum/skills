# Request Entra group or app access

**Skill:** `entra-access-request` · **Risk:** high · **Steps:** 12

Grants a Microsoft Entra ID user access to a specific security group, Microsoft 365 group, or enterprise application (service principal) they are currently missing — via direct group membership or an app role assignment, whichever the target actually requires.

## What it does, step by step

**Step 1.** Checks that the user's account exists and is enabled before granting any access.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Asks the user which group, list, site, Teams, or application they need access to.
_asks the user_ · `request_user_input`

**Step 3.** Searches for groups matching the request, excluding dynamic groups that can't take direct members.
_read-only_ · `c_entra_find_group`

**Step 4.** Searches for applications matching the request.
_read-only_ · `c_entra_find_app`

**Step 5.** Removes groups the user already belongs to from the candidate list.
_read-only_ · `c_entra_get_group_memberships`

**Step 6.** Removes applications the user is already assigned to from the candidate list.
_read-only_ · `c_entra_get_app_assignments`

**Step 7.** Shows the matching options and asks the user to confirm which one they actually need.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Adds the user to the chosen group and reports whether the update succeeded.
_makes a change, asks permission, preview first_ · `c_entra_add_to_group`

**Step 9.** Assigns the chosen application to the user and reports whether it succeeded.
_makes a change, asks permission, preview first_ · `c_entra_assign_app`

**Step 10.** Confirms the new group membership actually appears on the user's account.
_read-only_ · `c_entra_get_group_memberships`

**Step 11.** Confirms the new app assignment actually appears on the user's account.
_read-only_ · `c_entra_get_app_assignments`

**Step 12.** Confirms access was granted, notes propagation time, and flags related follow-up requests.
_no tools_

## Tools it may use

`c_entra_get_user_info`, `request_user_input`, `c_entra_find_group`, `c_entra_find_app`, `c_entra_get_group_memberships`, `c_entra_get_app_assignments`, `wait_for_user_ack`, `c_entra_add_to_group`, `c_entra_assign_app`
