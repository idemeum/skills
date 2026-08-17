# Request Entra group or app access

**Skill:** `entra-access-request` · **Risk:** high · **Steps:** 17

Grants a Microsoft Entra ID user access to a specific security group or enterprise application they are currently missing, resolving the exact group or app by name before adding membership or an app role assignment.

## What it does, step by step

**Step 1.** Checks whether the user's device is enrolled with Microsoft Entra before proceeding.
_read-only_ · `detect_identity_provider`

**Step 2.** Automatically finds the user's Entra sign-in username.
_read-only_ · `detect_idp_username`

**Step 3.** Confirms with the user which account to work with.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the user to manually provide their Entra sign-in name if it wasn't found.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Verifies the account exists and is enabled before continuing.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Asks the user which group, team, or application they need access to.
_asks the user_ · `request_user_input`

**Step 7.** Searches for groups matching the requested name, skipping ones that can't accept direct additions.
_read-only_ · `c_entra_find_group`

**Step 8.** Searches for applications matching the requested name.
_read-only_ · `c_entra_find_app`

**Step 9.** Checks which of the matching groups the user already belongs to.
_read-only_ · `c_entra_get_group_memberships`

**Step 10.** Checks which of the matching apps the user already has access to.
_read-only_ · `c_entra_get_app_assignments`

**Step 11.** Shows the remaining matching groups and apps and asks the user to pick one.
_asks the user_ · `wait_for_user_ack`

**Step 12.** Confirms with the user the exact group or app before making the change.
_asks the user_ · `wait_for_user_ack`

**Step 13.** Adds the user to the selected group.
_makes a change, asks permission, preview first, conditional_ · `c_entra_add_to_group`

**Step 14.** Assigns the selected application to the user.
_makes a change, asks permission, preview first, conditional_ · `c_entra_assign_app`

**Step 15.** Confirms the group membership was successfully added.
_read-only, conditional_ · `c_entra_get_group_memberships`

**Step 16.** Confirms the app assignment was successfully added.
_read-only, conditional_ · `c_entra_get_app_assignments`

**Step 17.** Explains the access change may take time and offers next steps if issues remain.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_find_group`, `c_entra_find_app`, `c_entra_get_group_memberships`, `c_entra_get_app_assignments`, `c_entra_add_to_group`, `c_entra_assign_app`
