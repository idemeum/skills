# No internet or Wi-Fi connection

**Skill:** `network-reset` · **Risk:** medium · **Steps:** 9

Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings.

## What it does, step by step

**Step 1.** Asks whether other devices are also offline before running diagnostics, since router or ISP issues need different action.
_asks the user_ · `wait_for_user_ack`

**Step 2.** Tests connectivity to key internet addresses and sites to determine whether the problem is connectivity, DNS, or something else.
_read-only_ · `check_connectivity`

**Step 3.** Examines network interfaces to find the active connection and checks whether it has a valid network address.
_read-only_ · `get_network_interfaces`

**Step 4.** Checks Wi-Fi signal strength to see if a weak connection is causing intermittent drops.
_read-only_ · `get_wifi_info`

**Step 5.** Renews the network address lease on the active connection and confirms it receives a valid address afterward.
_read-only, conditional_ · `renew_dhcp_lease`

**Step 6.** Clears the DNS cache and rechecks whether websites become reachable again.
_read-only, conditional_ · `flush_dns_cache`, `check_connectivity`

**Step 7.** Reviews proxy settings across protocols to find a misconfigured proxy silently blocking web access.
_read-only_ · `check_proxy_settings`

**Step 8.** Checks whether the firewall is blocking all connections, which could explain the outage.
_read-only_ · `check_firewall_status`

**Step 9.** Retests connectivity, reports what was fixed, and if problems remain, provides manual next steps and escalation details for IT.
_read-only_ · `check_connectivity`

## Tools it may use

`check_connectivity`, `get_network_interfaces`, `get_wifi_info`, `renew_dhcp_lease`, `flush_dns_cache`, `check_proxy_settings`, `check_firewall_status`, `wait_for_user_ack`
