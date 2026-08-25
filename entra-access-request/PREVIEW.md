# Request Entra group or app access

**Skill:** `entra-access-request` · **Risk:** high · **Steps:** 10

Grants a Microsoft Entra ID user access to a specific security group, Microsoft 365 group, or enterprise application they are currently missing, resolving the target by name search rather than requiring the user to know whether it is implemented as group membership or an app role assignment.

## What it does, step by step

**Step 1.** Confirms the user's account exists and checks whether it is currently enabled.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Asks the user which group or application they need access to.
_asks the user_ · `request_user_input`

**Step 3.** Searches for security or Microsoft 365 groups matching the requested name.
_read-only_ · `c_entra_find_group`

**Step 4.** Searches for applications matching the requested name.
_read-only_ · `c_entra_find_app`

**Step 5.** Removes any matching groups the user already belongs to from consideration.
_read-only_ · `c_entra_get_group_memberships`

**Step 6.** Removes any matching apps the user is already assigned from consideration.
_read-only_ · `c_entra_get_app_assignments`

**Step 7.** Shows the remaining matches and asks the user to confirm the exact one to grant.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Adds the user to the chosen group and reports success or failure.
_makes a change, asks permission, preview first, conditional_ · `c_entra_add_to_group`

**Step 9.** Assigns the chosen application to the user and reports success or failure.
_makes a change, asks permission, preview first, conditional_ · `c_entra_assign_app`

**Step 10.** Confirms access was granted and explains how long it may take to appear.
_no tools_

## Tools it may use

`request_user_input`, `c_entra_get_user_info`, `c_entra_find_group`, `c_entra_find_app`, `c_entra_get_group_memberships`, `c_entra_get_app_assignments`, `wait_for_user_ack`, `c_entra_add_to_group`, `c_entra_assign_app`
