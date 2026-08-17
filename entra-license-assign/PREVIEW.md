# Assign a Microsoft 365 licence to an Entra user

**Skill:** `entra-license-assign` · **Risk:** high · **Steps:** 13

Assigns a Microsoft 365 licence SKU (e.g. E3, E5, Teams Phone) to a Microsoft Entra ID user from the tenant's purchased seat pool.

## What it does, step by step

**Step 1.** Checks whether the user's device is enrolled with Microsoft Entra before continuing.
_read-only_ · `detect_identity_provider`

**Step 2.** Automatically discovers the user's Microsoft Entra username.
_read-only_ · `detect_idp_username`

**Step 3.** Asks the user to confirm which account to use, offering alternatives if several match.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Asks the user to manually provide their Entra username when it can't be found automatically.
_asks the user, conditional_ · `request_user_input`

**Step 5.** Verifies the account exists, is enabled, and has a usage location set for licensing.
_read-only_ · `c_entra_get_user_info`

**Step 6.** Checks which licences the user already has to avoid assigning duplicates.
_read-only_ · `c_entra_get_licenses`

**Step 7.** Checks which tenant licences have available seats and haven't already been assigned.
_read-only_ · `c_entra_get_available_licenses`

**Step 8.** Asks the user to choose which available licence to assign.
_asks the user_ · `wait_for_user_ack`

**Step 9.** Asks the user to type the exact licence name when too many options exist.
_asks the user, conditional_ · `request_user_input`

**Step 10.** Asks the user to explicitly confirm the licence assignment before proceeding.
_asks the user_ · `wait_for_user_ack`

**Step 11.** Assigns the selected licence to the user's account.
_makes a change, asks permission, preview first_ · `c_entra_assign_license`

**Step 12.** Confirms the new licence now appears on the user's account.
_read-only_ · `c_entra_get_licenses`

**Step 13.** Reports that the licence was assigned and explains next steps for access delays or extra access needs.
_no tools_

## Tools it may use

`detect_identity_provider`, `detect_idp_username`, `wait_for_user_ack`, `request_user_input`, `c_entra_get_user_info`, `c_entra_get_licenses`, `c_entra_get_available_licenses`, `c_entra_assign_license`
