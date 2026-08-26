# Assign a licence to an Entra user

**Skill:** `entra-license-assign` · **Risk:** high · **Steps:** 8

Assigns a Microsoft 365 licence SKU (e.g. E3, E5, Teams) to a Microsoft Entra ID user via the Graph API, after confirming the tenant has an available seat and the user has a usage location set.

## What it does, step by step

**Step 1.** Checks that the user's account exists, is enabled, and has a usage location set for licensing.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Lists the licences already assigned to the user to avoid offering duplicates.
_read-only_ · `c_entra_get_licenses`

**Step 3.** Checks the tenant's licence inventory for SKUs the user lacks with available seats remaining.
_read-only_ · `c_entra_get_available_licenses`

**Step 4.** Asks the user which available licence to assign from the eligible options.
_asks the user_ · `request_user_input`

**Step 5.** Confirms with the user before assigning the chosen licence.
_asks the user_ · `wait_for_user_ack`

**Step 6.** Assigns the selected licence to the user's account and reports any failure.
_makes a change, asks permission, preview first_ · `c_entra_assign_license`

**Step 7.** Confirms the new licence now appears on the user's account.
_read-only_ · `c_entra_get_licenses`

**Step 8.** Tells the user the licence is assigned and explains activation timing and next steps.
_no tools_

## Tools it may use

`c_entra_get_user_info`, `c_entra_get_licenses`, `c_entra_get_available_licenses`, `request_user_input`, `wait_for_user_ack`, `c_entra_assign_license`
