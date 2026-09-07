# No internet or Wi-Fi connection

**Skill:** `network-reset` · **Risk:** high · **Steps:** 13

Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings.

## What it does, step by step

**Step 1.** Asks whether other devices are also affected to rule out a router or ISP issue first.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Checks reachability, active connection, and Wi-Fi signal quality to pinpoint the connectivity problem.
_read-only, conditional_ · `survey_network`

**Step 3.** Renews the network address lease when the device has an invalid or self-assigned IP.
_read-only, conditional_ · `renew_dhcp_lease`

**Step 4.** Clears the DNS cache when websites fail to resolve despite a working connection.
_read-only, conditional_ · `flush_dns_cache`

**Step 5.** Checks whether a proxy is configured that might be blocking web access.
_read-only_ · `check_proxy_settings`

**Step 6.** Checks whether the configured proxy server itself is reachable.
_read-only_ · `check_connectivity`

**Step 7.** Turns off a proxy that is configured but unreachable, after confirming with the user.
_makes a change, asks permission, preview first_ · `disable_proxy`

**Step 8.** Checks whether the firewall is blocking all network connections.
_read-only_ · `check_firewall_status`

**Step 9.** Checks the device's management configuration for failed profiles when connectivity is still broken.
_read-only_ · `c_mdm_diagnose_configuration`

**Step 10.** Tells the device to re-check in and reapply its assigned configuration.
_makes a change, asks permission, preview first_ · `c_mdm_reapply_configuration`

**Step 11.** Waits for the reapplied configuration to take effect before retesting.
_asks the user_ · `wait_for_user_ack`

**Step 12.** Retests connectivity after a fix was applied to confirm it worked.
_read-only_ · `check_connectivity`

**Step 13.** Reports the diagnosis and any fixes made, and suggests manual steps if problems remain.
_no tools_

## Tools it may use

`survey_network`, `check_connectivity`, `renew_dhcp_lease`, `flush_dns_cache`, `check_proxy_settings`, `disable_proxy`, `check_firewall_status`, `c_mdm_diagnose_configuration`, `c_mdm_reapply_configuration`, `wait_for_user_ack`
