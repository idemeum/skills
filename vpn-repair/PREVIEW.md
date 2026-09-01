# VPN not connecting

**Skill:** `vpn-repair` · **Risk:** high · **Steps:** 20

Diagnoses and repairs VPN connectivity issues including stale connections, misconfigured profiles, expired certificates, missing network extensions, and DNS leaks.

## What it does, step by step

**Step 1.** Checks whether a VPN is currently connected and identifies if it uses a native profile or vendor client.
_read-only_ · `check_vpn_status`

**Step 2.** Retrieves all configured VPN profiles, including native and vendor-managed connections.
_makes a change, asks permission, preview first_ · `get_vpn_profiles`, `reconnect_vpn`

**Step 3.** Checks whether basic internet access is working before troubleshooting the VPN itself.
_read-only_ · `check_connectivity`

**Step 4.** Checks whether the VPN server itself can be reached over the network.
_read-only, conditional_ · `check_connectivity`

**Step 5.** Checks whether the VPN server's security certificate has expired, for certificate-based VPN types.
_read-only_ · `check_certificate_expiry`

**Step 6.** Lists all VPN and security network extensions installed on the device.
_read-only_ · `check_network_extension`

**Step 7.** Asks the user to approve a pending VPN network extension in system security settings.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Asks the user to choose which VPN profile to use when multiple are configured.
_asks the user, conditional_ · `wait_for_user_ack`, `request_user_input`

**Step 9.** Reconnects the VPN using the selected profile and confirms whether the connection actually settled.
_makes a change, asks permission, preview first_ · `reconnect_vpn`

**Step 10.** Asks the user to confirm once they've manually reconnected via their VPN client.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 11.** Clears cached DNS entries so hostnames resolve correctly through the reconnected VPN.
_read-only, conditional_ · `flush_dns_cache`

**Step 12.** Asks the user for an internal address to test whether VPN traffic is routing properly.
_asks the user, conditional_ · `request_user_input`

**Step 13.** Checks whether the provided internal address is reachable to confirm VPN traffic is routing.
_read-only, conditional_ · `check_connectivity`

**Step 14.** Checks device management enrollment to see if a stale client certificate may be blocking connection.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 15.** Looks up the device record in Intune to confirm it's recognized and actively checking in.
_read-only, conditional_ · `c_intune_find_device`

**Step 16.** Checks whether a certificate profile is assigned to the device and whether it applied successfully.
_read-only_ · `c_intune_get_configuration_states`

**Step 17.** Tells the device to re-check in and reapply its assigned configuration, including certificates.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 18.** Asks the user to wait while the certificate is re-issued, then confirm when ready to retry.
_asks the user_ · `wait_for_user_ack`

**Step 19.** Retries the VPN connection and confirms whether the certificate re-issue actually fixed it.
_makes a change, asks permission, preview first_ · `reconnect_vpn`

**Step 20.** Summarizes findings and fixes, escalating to IT for issues it cannot resolve directly.
_no tools_

## Tools it may use

`check_vpn_status`, `get_vpn_profiles`, `check_connectivity`, `check_certificate_expiry`, `check_network_extension`, `reconnect_vpn`, `flush_dns_cache`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`, `request_user_input`
