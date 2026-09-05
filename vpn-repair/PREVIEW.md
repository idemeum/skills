# VPN not connecting

**Skill:** `vpn-repair` · **Risk:** high · **Steps:** 16

Diagnoses and repairs VPN connectivity issues including stale connections, misconfigured profiles, expired certificates, missing network extensions, and DNS leaks.

## What it does, step by step

**Step 1.** Checks whether a VPN tunnel is active and identifies which profiles can be automatically reconnected.
_read-only_ · `survey_vpn`

**Step 2.** Verifies the device has working internet access before attempting any VPN fix.
_read-only_ · `check_connectivity`

**Step 3.** Checks whether the VPN server itself is reachable when the tunnel is down.
_read-only, conditional_ · `check_connectivity`

**Step 4.** Lists all VPN and security network extensions installed on the device.
_read-only_ · `check_network_extension`

**Step 5.** Asks the user to approve a pending network extension in system settings on Mac.
_asks the user_ · `wait_for_user_ack`

**Step 6.** Asks the user which VPN profile to use when multiple are configured.
_asks the user, conditional_ · `wait_for_user_ack`, `request_user_input`

**Step 7.** Reconnects the VPN using the selected profile and reports whether it succeeded.
_makes a change, asks permission, preview first_ · `reconnect_vpn`

**Step 8.** Asks the user to confirm the VPN reconnected after a manual or vendor-driven sign-in.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 9.** Clears cached DNS entries that could still point to addresses outside the VPN tunnel.
_read-only, conditional_ · `flush_dns_cache`

**Step 10.** Asks the user for an internal address to test whether traffic is routing through the VPN.
_asks the user, conditional_ · `request_user_input`

**Step 11.** Checks whether the provided internal address is reachable through the VPN tunnel.
_read-only, conditional_ · `check_connectivity`

**Step 12.** Checks the device's management configuration for a failed or missing VPN certificate.
_read-only, conditional_ · `c_mdm_diagnose_configuration`

**Step 13.** Tells the device to re-check in and reapply its assigned configuration and certificates.
_makes a change, asks permission, preview first_ · `c_mdm_reapply_configuration`

**Step 14.** Waits for the user to confirm before retrying the connection after certificate reissuance.
_asks the user_ · `wait_for_user_ack`

**Step 15.** Retries the VPN connection and confirms whether the certificate fix actually resolved it.
_makes a change, asks permission, preview first_ · `reconnect_vpn`

**Step 16.** Summarizes what was found and fixed, and flags any issues needing IT escalation.
_no tools_

## Tools it may use

`survey_vpn`, `check_connectivity`, `check_network_extension`, `reconnect_vpn`, `flush_dns_cache`, `c_mdm_diagnose_configuration`, `c_mdm_reapply_configuration`, `wait_for_user_ack`, `request_user_input`
