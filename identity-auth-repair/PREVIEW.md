# Login or SSO keeps failing across multiple apps

**Skill:** `identity-auth-repair` · **Risk:** medium · **Steps:** 11

Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures.

## What it does, step by step

**Step 1.** Checks whether the device's clock has drifted enough to break Kerberos and SSO logins.
_read-only_ · `check_ntp_status`

**Step 2.** Syncs the device's clock to the correct time after asking for confirmation.
_makes a change, asks permission, preview first_ · `sync_system_time`

**Step 3.** Waits for the user to confirm they manually synced the clock with elevated rights.
_asks the user_ · `wait_for_user_ack`, `check_ntp_status`

**Step 4.** Checks whether Kerberos login tickets are missing, expired, or about to expire.
_read-only_ · `check_kerberos_ticket`

**Step 5.** Renews the expired or expiring Kerberos ticket after asking for confirmation.
_makes a change, asks permission, preview first_ · `renew_kerberos_ticket`, `check_kerberos_ticket`

**Step 6.** Waits for the user to confirm they manually renewed their Kerberos ticket.
_asks the user_ · `wait_for_user_ack`, `check_kerberos_ticket`

**Step 7.** Checks all client certificates for expiry or upcoming expiration.
_read-only_ · `list_client_certificates`

**Step 8.** Asks which VPN or SSO server address is failing, if not already known.
_asks the user_ · `request_user_input`

**Step 9.** Checks whether the VPN or SSO server's own certificate is expiring.
_read-only_ · `check_certificate_expiry`

**Step 10.** Checks whether the device's domain connection is broken or missing.
_read-only_ · `check_ad_binding`

**Step 11.** Summarizes findings and fixes, and advises next steps or escalation.
_no tools_

## Tools it may use

`check_ntp_status`, `sync_system_time`, `check_kerberos_ticket`, `renew_kerberos_ticket`, `list_client_certificates`, `check_certificate_expiry`, `check_ad_binding`, `wait_for_user_ack`, `request_user_input`
