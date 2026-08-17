# VPN not connecting

**Skill:** `vpn-repair` · **Risk:** medium · **Steps:** 14

Diagnoses and repairs VPN connectivity issues including stale connections, misconfigured profiles, expired certificates, missing network extensions, and DNS leaks.

## What it does, step by step

**Step 1.** Checks whether the VPN is currently connected and identifies which VPN client is in use.
_read-only_ · `check_vpn_status`

**Step 2.** Looks up the VPN connection profiles configured on the device.
_deletes data, asks permission, preview first_ · `get_vpn_profiles`, `reconnect_vpn`

**Step 3.** Checks whether the device has basic internet access at all.
_read-only_ · `check_connectivity`

**Step 4.** Checks whether the VPN server itself can be reached.
_read-only, conditional_ · `check_connectivity`

**Step 5.** Checks whether the VPN's security certificate has expired, for certificate-based VPNs only.
_read-only_ · `check_certificate_expiry`

**Step 6.** Lists all VPN and security network extensions installed on the device.
_read-only_ · `check_network_extension`

**Step 7.** Asks the user to approve a pending VPN network extension in system settings.
_asks the user_ · `wait_for_user_ack`

**Step 8.** Asks the user which VPN profile to use when more than one exists.
_asks the user, conditional_ · `wait_for_user_ack`, `request_user_input`

**Step 9.** Reconnects the VPN using the selected profile and confirms whether it came back online.
_deletes data, asks permission, preview first_ · `reconnect_vpn`

**Step 10.** Asks the user to confirm they've manually reconnected and signed back into the VPN.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 11.** Clears cached DNS entries left over from before the tunnel reconnected.
_read-only, conditional_ · `flush_dns_cache`

**Step 12.** Asks the user for an internal address to test whether traffic routes through the tunnel.
_asks the user, conditional_ · `request_user_input`

**Step 13.** Checks whether the internal address is reachable to confirm the tunnel is routing traffic.
_read-only, conditional_ · `check_connectivity`

**Step 14.** Summarizes findings and fixes, escalating certificate, extension, or server issues to IT as needed.
_no tools_

## Tools it may use

`check_vpn_status`, `get_vpn_profiles`, `check_connectivity`, `check_certificate_expiry`, `check_network_extension`, `reconnect_vpn`, `flush_dns_cache`, `wait_for_user_ack`, `request_user_input`
