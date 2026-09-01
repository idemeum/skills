# No internet or Wi-Fi connection

**Skill:** `network-reset` · **Risk:** high · **Steps:** 16

Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings.

## What it does, step by step

**Step 1.** Asks whether other devices are also affected to rule out a router or ISP outage first.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Tests connectivity to key internet addresses to determine if the connection is down, unstable, or DNS-related.
_read-only_ · `check_connectivity`

**Step 3.** Examines network interfaces to find the active connection and detect hardware, driver, or address problems.
_read-only_ · `get_network_interfaces`

**Step 4.** Checks Wi-Fi signal strength to see if poor reception explains intermittent connection drops.
_read-only_ · `get_wifi_info`

**Step 5.** Renews the network address lease on the affected connection and confirms it receives a valid address.
_read-only, conditional_ · `renew_dhcp_lease`

**Step 6.** Clears the cached DNS records and verifies that website name lookups work again.
_read-only, conditional_ · `flush_dns_cache`, `check_connectivity`

**Step 7.** Reviews configured proxy settings to see which ones are active and where they point.
_read-only_ · `check_proxy_settings`

**Step 8.** Checks whether the configured proxy server itself can actually be reached.
_read-only_ · `check_connectivity`

**Step 9.** Turns off a proxy that is enabled but unreachable, without erasing its saved settings.
_makes a change, asks permission, preview first_ · `disable_proxy`

**Step 10.** Checks whether the firewall is blocking all network connections.
_read-only_ · `check_firewall_status`

**Step 11.** Determines whether the device is enrolled and managed through Microsoft Intune.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 12.** Looks up the device record in Intune and checks how recently it last checked in.
_read-only, conditional_ · `c_intune_find_device`

**Step 13.** Identifies which specific device configuration profile is failing and causing the issue.
_read-only_ · `c_intune_get_configuration_states`

**Step 14.** Tells the device to re-check in and reapply all its assigned management configuration.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 15.** Waits for the resynced configuration to finish applying before retesting the connection.
_asks the user_ · `wait_for_user_ack`

**Step 16.** Retests the connection, reports the diagnosis, and offers manual next steps if it's still broken.
_read-only_ · `check_connectivity`

## Tools it may use

`check_connectivity`, `get_network_interfaces`, `get_wifi_info`, `renew_dhcp_lease`, `flush_dns_cache`, `check_proxy_settings`, `disable_proxy`, `check_firewall_status`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_configuration_states`, `c_intune_sync_device`, `wait_for_user_ack`
