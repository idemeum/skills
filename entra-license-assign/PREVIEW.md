# Assign a Microsoft 365 licence in Entra

**Skill:** `entra-license-assign` · **Risk:** high · **Steps:** 8

Assigns a Microsoft 365 licence SKU (e.g. E3, E5) to a Microsoft Entra ID user via the admin Graph API, after confirming the tenant has purchased seats available and the user has a usage location set — a hard Microsoft precondition.

## What it does, step by step

**Step 1.** Checks the user's account details and confirms a usage location is set before continuing.
_read-only_ · `c_entra_get_user_info`

**Step 2.** Looks up which licences the user already holds to avoid duplicate assignments.
_read-only_ · `c_entra_get_licenses`

**Step 3.** Checks the tenant's available licences and shows options with unused seats the user doesn't already have.
_read-only_ · `c_entra_get_available_licenses`

**Step 4.** Asks the user to pick which eligible licence they want assigned.
_asks the user_ · `request_user_input`

**Step 5.** Confirms with the user before assigning the chosen licence, showing remaining seats afterward.
_asks the user_ · `wait_for_user_ack`

**Step 6.** Assigns the confirmed licence to the user's account and reports any failure.
_makes a change, asks permission, preview first_ · `c_entra_assign_license`

**Step 7.** Rechecks the user's licences to confirm the new one was successfully added.
_read-only_ · `c_entra_get_licenses`

**Step 8.** Confirms the licence was assigned and explains that features may take a few minutes to appear.
_no tools_

## Tools it may use

`request_user_input`, `wait_for_user_ack`, `c_entra_get_user_info`, `c_entra_get_licenses`, `c_entra_get_available_licenses`, `c_entra_assign_license`
