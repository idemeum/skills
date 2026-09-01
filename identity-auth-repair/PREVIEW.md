# Login or SSO keeps failing across multiple apps

**Skill:** `identity-auth-repair` · **Risk:** high · **Steps:** 17

Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures.

## What it does, step by step

**Step 1.** Checks whether the device's clock has drifted enough to break Kerberos, SAML, and TOTP logins at once.
_read-only_ · `check_ntp_status`

**Step 2.** Syncs the system clock to correct detected time drift, after user approval.
_makes a change, asks permission, preview first_ · `sync_system_time`

**Step 3.** Waits for the user to confirm they manually ran the elevated time-sync command.
_asks the user_ · `wait_for_user_ack`, `check_ntp_status`

**Step 4.** Checks whether Kerberos login tickets are healthy, expiring, expired, or missing.
_read-only_ · `check_kerberos_ticket`

**Step 5.** Renews the user's Kerberos ticket automatically where possible, after user approval.
_makes a change, asks permission, preview first_ · `renew_kerberos_ticket`, `check_kerberos_ticket`

**Step 6.** Waits for the user to confirm they manually renewed their Kerberos ticket.
_asks the user_ · `wait_for_user_ack`, `check_kerberos_ticket`

**Step 7.** Checks all client certificates on the device for expiry or upcoming expiry.
_read-only_ · `list_client_certificates`

**Step 8.** Asks which VPN or SSO endpoint is failing, if not already specified.
_asks the user_ · `request_user_input`

**Step 9.** Checks whether the remote VPN or SSO server's certificate is expiring, ruling out a false lead.
_read-only_ · `check_certificate_expiry`

**Step 10.** Checks whether the device's domain binding is intact, since a break mimics other login failures.
_read-only_ · `check_ad_binding`

**Step 11.** Checks whether the device is Intune-managed so its certificate could be reissued remotely.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 12.** Finds the device's record in Intune and checks whether it's still actively checking in.
_read-only, conditional_ · `c_intune_find_device`

**Step 13.** Checks whether a certificate profile is assigned to the device and whether it applied successfully.
_read-only_ · `c_intune_get_configuration_states`

**Step 14.** Tells the device to re-check in and reapply its assigned configuration, including certificates.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 15.** Waits before rechecking, giving Intune time to reissue the certificate after the sync.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Rechecks the device's certificates to confirm a fresh one was actually issued.
_read-only_ · `list_client_certificates`

**Step 17.** Summarizes findings, confirms fixes applied, and advises next steps or escalation for anything unresolved.
_no tools_

## Tools it may use

`check_ntp_status`, `sync_system_time`, `check_kerberos_ticket`, `renew_kerberos_ticket`, `list_client_certificates`, `check_certificate_expiry`, `check_ad_binding`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`, `request_user_input`
