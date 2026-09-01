# No internet or Wi-Fi connection

**Skill:** `network-reset` · **Risk:** high · **Steps:** 17

Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings.

## What it does, step by step

**Step 1.** Asks whether other devices are also offline, to tell a router/ISP issue from a device issue.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Tests whether the device can reach the internet and pinpoints the type of failure.
_read-only_ · `check_connectivity`

**Step 3.** Examines the device's network interfaces to find which one is active and misconfigured.
_read-only_ · `get_network_interfaces`

**Step 4.** Checks Wi-Fi signal strength to see if a weak connection explains intermittent drops.
_read-only_ · `get_wifi_info`

**Step 5.** Requests a fresh network address for the connection when it lacks a valid one.
_read-only, conditional_ · `renew_dhcp_lease`

**Step 6.** Clears the DNS cache and confirms whether website addresses now resolve correctly.
_read-only, conditional_ · `flush_dns_cache`, `check_connectivity`

**Step 7.** Reviews configured proxy settings that could be silently blocking web access.
_read-only_ · `check_proxy_settings`

**Step 8.** Checks whether a configured proxy server can actually be reached.
_read-only_ · `check_connectivity`

**Step 9.** Turns off a proxy that is configured but unreachable, after confirming with the user.
_makes a change, asks permission, preview first_ · `disable_proxy`

**Step 10.** Checks whether the firewall is blocking all network connections.
_read-only_ · `check_firewall_status`

**Step 11.** Determines whether the device is managed by Intune before pursuing a policy-based fix.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 12.** Looks up the device's record in Intune to check its management status.
_read-only, conditional_ · `c_intune_find_device`

**Step 13.** Identifies which specific configuration profile is failing on the device.
_read-only_ · `c_intune_get_configuration_states`

**Step 14.** Asks the device to re-sync and reapply all its assigned configuration policies.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 15.** Waits for the resynced configuration to take effect before retesting.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Retests connectivity after a fix was applied to confirm it worked.
_read-only_ · `check_connectivity`

**Step 17.** Summarizes findings and fixes, and gives manual next steps if problems remain.
_no tools_

## Tools it may use

`check_connectivity`, `get_network_interfaces`, `get_wifi_info`, `renew_dhcp_lease`, `flush_dns_cache`, `check_proxy_settings`, `disable_proxy`, `check_firewall_status`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`
