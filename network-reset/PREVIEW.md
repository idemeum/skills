# No internet or Wi-Fi connection

**Skill:** `network-reset` · **Risk:** high · **Steps:** 16

Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings.

## What it does, step by step

**Step 1.** Asks whether other devices share the same connection problem before running diagnostics.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Tests connectivity to key internet destinations to classify the type of connection failure.
_read-only_ · `check_connectivity`

**Step 3.** Inspects network interfaces to identify the active connection and detect hardware or address problems.
_read-only_ · `get_network_interfaces`

**Step 4.** Checks Wi-Fi signal strength to see if a weak connection explains intermittent drops.
_read-only_ · `get_wifi_info`

**Step 5.** Renews the device's network address lease and confirms it received a valid address.
_read-only, conditional_ · `renew_dhcp_lease`

**Step 6.** Clears the DNS cache and re-checks whether website names resolve correctly.
_read-only, conditional_ · `flush_dns_cache`, `check_connectivity`

**Step 7.** Reviews configured proxy settings that could be silently blocking internet access.
_read-only_ · `check_proxy_settings`

**Step 8.** Checks whether the configured proxy server itself is actually reachable.
_read-only_ · `check_connectivity`

**Step 9.** Turns off a proxy that is configured but unreachable, without erasing its settings.
_makes a change, asks permission, preview first_ · `disable_proxy`

**Step 10.** Checks whether firewall settings are blocking all network connections.
_read-only_ · `check_firewall_status`

**Step 11.** Determines whether the device is enrolled and managed through Intune.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 12.** Looks up the device record in Intune to check its management status.
_read-only, conditional_ · `c_intune_find_device`

**Step 13.** Identifies which configuration profile is failing and likely causing the issue.
_read-only_ · `c_intune_get_configuration_states`

**Step 14.** Tells the device to check in and reapply all its assigned configuration.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 15.** Waits for the reapplied configuration to take effect before retesting.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Retests the connection and, if still broken, provides manual next steps and escalation details.
_read-only_ · `check_connectivity`

## Tools it may use

`check_connectivity`, `get_network_interfaces`, `get_wifi_info`, `renew_dhcp_lease`, `flush_dns_cache`, `check_proxy_settings`, `disable_proxy`, `check_firewall_status`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`
