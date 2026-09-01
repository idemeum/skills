# Login or SSO keeps failing across multiple apps

**Skill:** `identity-auth-repair` · **Risk:** high · **Steps:** 17

Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures.

## What it does, step by step

**Step 1.** Checks whether the device's clock has drifted enough to break Kerberos, SAML, and TOTP simultaneously.
_read-only_ · `check_ntp_status`

**Step 2.** Syncs the system clock to the correct time after user approval, fixing detected drift.
_makes a change, asks permission, preview first_ · `sync_system_time`

**Step 3.** Waits for the user to confirm they manually ran the time-sync command with elevated rights.
_asks the user_ · `wait_for_user_ack`, `check_ntp_status`

**Step 4.** Checks whether Kerberos tickets are valid, expiring, expired, or missing entirely.
_read-only_ · `check_kerberos_ticket`

**Step 5.** Renews the Kerberos ticket automatically after approval, when possible on this platform.
_makes a change, asks permission, preview first_ · `renew_kerberos_ticket`, `check_kerberos_ticket`

**Step 6.** Waits for the user to confirm they manually completed the interactive ticket renewal.
_asks the user_ · `wait_for_user_ack`, `check_kerberos_ticket`

**Step 7.** Lists client certificates and flags any that are expired or expiring soon.
_read-only_ · `list_client_certificates`

**Step 8.** Asks the user which VPN or SSO endpoint is failing, if not already known.
_asks the user_ · `request_user_input`

**Step 9.** Checks whether the remote VPN or SSO endpoint's certificate is expiring, ruling out a false lead.
_read-only_ · `check_certificate_expiry`

**Step 10.** Checks whether the device's domain binding is broken, a cause that mimics other auth failures.
_read-only_ · `check_ad_binding`

**Step 11.** Checks whether the device is enrolled in Intune so its certificate could be re-issued remotely.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 12.** Finds the device's unique record in Intune and confirms it is still actively checking in.
_read-only, conditional_ · `c_intune_find_device`

**Step 13.** Checks whether a certificate profile is assigned to the device and whether it applied successfully.
_read-only_ · `c_intune_get_configuration_states`

**Step 14.** Tells the device to check in and re-apply its assigned configuration, including the certificate.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 15.** Waits for the user's go-ahead before re-checking whether the certificate was re-issued.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Rechecks the device's certificates to confirm whether re-issuance actually succeeded.
_read-only_ · `list_client_certificates`

**Step 17.** Summarizes findings and fixes, and advises next steps for anything that couldn't be resolved automatically.
_no tools_

## Tools it may use

`check_ntp_status`, `sync_system_time`, `check_kerberos_ticket`, `renew_kerberos_ticket`, `list_client_certificates`, `check_certificate_expiry`, `check_ad_binding`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`, `request_user_input`
