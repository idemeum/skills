# No internet or Wi-Fi connection

**Skill:** `network-reset` · **Risk:** high · **Steps:** 17

Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings.

## What it does, step by step

**Step 1.** Asks whether other devices are also affected, to distinguish a router/ISP issue from a device issue.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Checks whether the device can reach the internet and classifies the type of failure found.
_read-only_ · `check_connectivity`

**Step 3.** Inspects network interfaces to identify the active connection and detect hardware or address problems.
_read-only_ · `get_network_interfaces`

**Step 4.** Checks Wi-Fi signal strength to see if a weak connection explains intermittent drops.
_read-only_ · `get_wifi_info`

**Step 5.** Renews the device's network address lease and confirms it receives a valid address.
_read-only, conditional_ · `renew_dhcp_lease`

**Step 6.** Clears the DNS cache and verifies whether websites become reachable again.
_read-only, conditional_ · `flush_dns_cache`, `check_connectivity`

**Step 7.** Checks whether a proxy is configured and reports which connection types it affects.
_read-only_ · `check_proxy_settings`

**Step 8.** Checks whether the configured proxy server itself can be reached.
_read-only_ · `check_connectivity`

**Step 9.** Turns off a proxy that is configured but unreachable, after confirming with the user.
_makes a change, asks permission, preview first_ · `disable_proxy`

**Step 10.** Checks whether the firewall is blocking all connections.
_read-only_ · `check_firewall_status`

**Step 11.** Checks whether the device is managed through Intune before attempting policy-based fixes.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 12.** Looks up the device in Intune and checks whether it is checking in properly.
_read-only, conditional_ · `c_intune_find_device`

**Step 13.** Identifies which specific configuration profile is failing on the device.
_read-only_ · `c_intune_get_configuration_states`

**Step 14.** Tells the device to re-sync and reapply all its assigned configuration.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 15.** Waits for the resynced configuration to finish applying before re-testing.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Re-checks internet connectivity after a fix was applied, to confirm it worked.
_read-only_ · `check_connectivity`

**Step 17.** Reports the diagnosis and any fix applied, and gives manual next steps if still broken.
_no tools_

## Tools it may use

`check_connectivity`, `get_network_interfaces`, `get_wifi_info`, `renew_dhcp_lease`, `flush_dns_cache`, `check_proxy_settings`, `disable_proxy`, `check_firewall_status`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`
