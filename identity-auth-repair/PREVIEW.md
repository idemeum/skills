# Login or SSO keeps failing across multiple apps

**Skill:** `identity-auth-repair` · **Risk:** high · **Steps:** 10

Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures.

## What it does, step by step

**Step 1.** Checks the device's clock, Kerberos ticket, client certificates, and domain binding for the likely single cause.
_read-only_ · `survey_identity`

**Step 2.** Corrects the device's clock when it has drifted enough to break sign-in.
_makes a change, asks permission, preview first_ · `sync_system_time`

**Step 3.** Waits for the user to confirm they've manually synced the clock with elevated permissions.
_asks the user_ · `wait_for_user_ack`, `check_ntp_status`

**Step 4.** Renews an expiring or expired Kerberos ticket so sign-in works again.
_makes a change, asks permission, preview first_ · `renew_kerberos_ticket`, `check_kerberos_ticket`

**Step 5.** Waits for the user to confirm they've manually renewed their Kerberos ticket.
_asks the user_ · `wait_for_user_ack`, `check_kerberos_ticket`

**Step 6.** Checks whether device management can detect and reissue a failed client certificate.
_read-only_ · `c_mdm_diagnose_configuration`

**Step 7.** Tells the device to re-check in and reapply its assigned configuration, including certificates.
_makes a change, asks permission, preview first_ · `c_mdm_reapply_configuration`

**Step 8.** Waits briefly for the reissued certificate to arrive before checking again.
_asks the user_ · `wait_for_user_ack`

**Step 9.** Rechecks the device's certificates to confirm a new one was actually issued.
_read-only_ · `list_client_certificates`

**Step 10.** Reports what was found and fixed, and guides the user on any remaining manual steps.
_no tools_

## Tools it may use

`survey_identity`, `sync_system_time`, `renew_kerberos_ticket`, `list_client_certificates`, `check_ntp_status`, `check_kerberos_ticket`, `c_mdm_diagnose_configuration`, `c_mdm_reapply_configuration`, `wait_for_user_ack`
