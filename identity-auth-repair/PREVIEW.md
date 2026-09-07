# Login or SSO keeps failing across multiple apps

**Skill:** `identity-auth-repair` · **Risk:** high · **Steps:** 10

Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures.

## What it does, step by step

**Step 1.** Checks the device's clock, Kerberos ticket, certificates, and domain binding for the likely cause of failed logins.
_read-only_ · `survey_identity`

**Step 2.** Synchronizes the system clock when it has drifted enough to break authentication.
_makes a change, asks permission, preview first_ · `sync_system_time`

**Step 3.** Waits for the user to confirm they've manually run the time-sync command as admin.
_asks the user_ · `wait_for_user_ack`, `check_ntp_status`

**Step 4.** Renews an expiring or expired Kerberos ticket so single sign-on works again.
_makes a change, asks permission, preview first_ · `renew_kerberos_ticket`, `check_kerberos_ticket`

**Step 5.** Waits for the user to confirm they've manually renewed their Kerberos ticket.
_asks the user_ · `wait_for_user_ack`, `check_kerberos_ticket`

**Step 6.** Checks whether device management can detect and reissue a failed client certificate.
_read-only_ · `c_mdm_diagnose_configuration`

**Step 7.** Tells the device to re-check in and reapply its assigned configuration, including certificates.
_makes a change, asks permission, preview first_ · `c_mdm_reapply_configuration`

**Step 8.** Waits a couple of minutes for the reissued certificate to arrive before rechecking.
_asks the user_ · `wait_for_user_ack`

**Step 9.** Rechecks certificates to confirm a new one was actually issued after the resync.
_read-only_ · `list_client_certificates`

**Step 10.** Summarizes what was found and fixed, and advises the user on any remaining next steps.
_no tools_

## Tools it may use

`survey_identity`, `sync_system_time`, `renew_kerberos_ticket`, `list_client_certificates`, `check_ntp_status`, `check_kerberos_ticket`, `c_mdm_diagnose_configuration`, `c_mdm_reapply_configuration`, `wait_for_user_ack`
