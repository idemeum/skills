# Request Entra group or app access

**Skill:** `entra-access-request` · **Risk:** high · **Steps:** 12

Grants a Microsoft Entra ID user access to a specific security group, Microsoft 365 group, or enterprise application (service principal) they are currently missing — via direct group membership or an app role assignment, whichever the target actually requires.

## What it does, step by step

**Step 1.** Checks that the user's account exists and is enabled before requesting access.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Asks the user which group, list, site, or application they need access to.
_asks the user_ · `request_user_input`

**Step 3.** Searches for matching groups, excluding ones with rule-based membership that can't accept direct additions.
_read-only_ · `c_entra_find_group`

**Step 4.** Searches for matching applications the user might need.
_read-only_ · `c_entra_find_app`

**Step 5.** Checks current group memberships and removes groups the user already belongs to from the list.
_read-only_ · `c_entra_get_group_memberships`

**Step 6.** Checks current app assignments and removes apps the user already has from the list.
_read-only_ · `c_entra_get_app_assignments`

**Step 7.** Asks the user to confirm the exact group or app they need, or cancel if none match.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Adds the user to the chosen group and reports success or failure.
_makes a change, asks permission, preview first_ · `c_entra_add_to_group`

**Step 9.** Assigns the chosen application to the user and reports success or failure.
_makes a change, asks permission, preview first_ · `c_entra_assign_app`

**Step 10.** Confirms the new group membership actually appears for the user.
_read-only_ · `c_entra_get_group_memberships`

**Step 11.** Confirms the new app assignment actually appears for the user.
_read-only_ · `c_entra_get_app_assignments`

**Step 12.** Confirms access was granted, notes propagation time, and suggests related follow-up requests if needed.
_no tools_

## Tools it may use

`c_entra_get_user_info`, `request_user_input`, `c_entra_find_group`, `c_entra_find_app`, `c_entra_get_group_memberships`, `c_entra_get_app_assignments`, `wait_for_user_ack`, `c_entra_add_to_group`, `c_entra_assign_app`
