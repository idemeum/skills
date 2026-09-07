# VPN not connecting

**Skill:** `vpn-repair` · **Risk:** high · **Steps:** 16

Diagnoses and repairs VPN connectivity issues including stale connections, misconfigured profiles, expired certificates, missing network extensions, and DNS leaks.

## What it does, step by step

**Step 1.** Checks whether a VPN tunnel is active and what profiles are configured on the device.
_read-only_ · `survey_vpn`

**Step 2.** Checks whether the device has basic internet access before troubleshooting the VPN itself.
_read-only_ · `check_connectivity`

**Step 3.** Checks whether the VPN server itself is reachable when the VPN is disconnected.
_read-only, conditional_ · `check_connectivity`

**Step 4.** Lists all VPN and security network extensions installed on the device and their states.
_read-only_ · `check_network_extension`

**Step 5.** Asks the user to approve a pending network extension in system security settings.
_asks the user_ · `wait_for_user_ack`

**Step 6.** Asks the user which configured VPN profile to reconnect when several exist.
_asks the user, conditional_ · `wait_for_user_ack`, `request_user_input`

**Step 7.** Reconnects the VPN using the selected profile and reports whether it succeeded.
_makes a change, asks permission, preview first_ · `reconnect_vpn`

**Step 8.** Asks the user to confirm they've manually reconnected when automatic reconnection can't be confirmed.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 9.** Clears cached DNS entries left over from before the tunnel reconnected.
_read-only, conditional_ · `flush_dns_cache`

**Step 10.** Asks the user for an internal address to test whether traffic routes through the tunnel.
_asks the user, conditional_ · `request_user_input`

**Step 11.** Checks whether the provided internal address is reachable through the reconnected VPN.
_read-only, conditional_ · `check_connectivity`

**Step 12.** Checks the device's management configuration for a failed certificate profile causing the fault.
_read-only, conditional_ · `c_mdm_diagnose_configuration`

**Step 13.** Tells the device to re-check-in and reapply its assigned configuration and certificates.
_makes a change, asks permission, preview first_ · `c_mdm_reapply_configuration`

**Step 14.** Asks the user to wait for the certificate to reissue before retrying the connection.
_asks the user_ · `wait_for_user_ack`

**Step 15.** Retries the VPN connection after the configuration re-sync and reports the outcome.
_makes a change, asks permission, preview first_ · `reconnect_vpn`

**Step 16.** Summarizes the findings and fixes, escalating unresolved issues to IT.
_no tools_

## Tools it may use

`survey_vpn`, `check_connectivity`, `check_network_extension`, `reconnect_vpn`, `flush_dns_cache`, `c_mdm_diagnose_configuration`, `c_mdm_reapply_configuration`, `wait_for_user_ack`, `request_user_input`
