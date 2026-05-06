---
name: network-reset
description: Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings. Use when user has no or intermittent internet access.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_connectivity
  - get_network_interfaces
  - get_wifi_info
  - renew_dhcp_lease
  - flush_dns_cache
  - check_proxy_settings
  - check_firewall_status
  - forget_wifi_network
  - reset_network_settings
metadata:
  prerequisites:
    before-corrective:
      - check_connectivity
      - get_network_interfaces
      - get_wifi_info
  maxAggregateRisk: high
  userLabel: "No internet or Wi-Fi connection"
  examples:
    - "I can't connect to the internet"
    - "my Wi-Fi isn't working"
    - "no internet access on my laptop"
    - "Wi-Fi keeps dropping out"
    - "I can't access any websites"
  pill:
    label: Fix Network
    goal: I have no internet or my network connection is not working, please diagnose and fix it
    icon: Wifi
    iconClass: text-green-500
    order: 3
---

## When to use

Use this skill when the user:
- Has no internet access or very intermittent connectivity
- Reports Wi-Fi shows connected but pages won't load
- Gets DNS resolution errors ("server not found", "DNS_PROBE_FINISHED_NXDOMAIN")
- Reports that the network was working and then stopped after a settings change
- Has an APIPA address (169.254.x.x) indicating a DHCP failure
- Asks "why is my internet not working?" or "my Wi-Fi is connected but nothing loads"

Do NOT use this skill for VPN-specific issues — use the `vpn-repair` skill once basic connectivity is confirmed working.

---

## Steps

**Step 1 — Baseline connectivity check**
Call `check_connectivity` with default targets (8.8.8.8, 1.1.1.1, google.com). This immediately classifies the failure:
- All targets unreachable → no connectivity at all (proceed to Step 2)
- IP targets (8.8.8.8) reachable but google.com not → DNS failure (skip to Step 5)
- Intermittent failures → unstable connection (proceed to Step 3)
- All targets reachable → connectivity is actually fine; the user's issue may be app-specific

**Step 2 — Inspect network interfaces**
Call `get_network_interfaces` to list all interfaces and their status. Look for:
- No active interface (all down) → hardware/driver issue
- Active interface with 169.254.x.x IP → DHCP failure (skip to Step 4)
- Active interface with valid IP → routing or firewall issue (skip to Step 6)

**Step 3 — Check Wi-Fi signal (if Wi-Fi)**
If the user is on Wi-Fi, call `get_wifi_info` to check signal strength and channel. A poor signal (RSSI below -70 dBm, linkQuality "poor") explains intermittent connectivity — advise the user to move closer to the router before attempting software fixes.

**Step 4 — Renew DHCP lease**
If the interface has a 169.254.x.x address or no IP at all, call `renew_dhcp_lease` to release and renew the IP address. After renewal, call `get_network_interfaces` again to confirm a valid IP was assigned.

**Step 5 — Flush DNS cache**
If IP-level connectivity works (8.8.8.8 reachable) but hostnames fail, call `flush_dns_cache` to clear stale DNS entries. After flushing, call `check_connectivity` again using google.com to verify DNS resolution is restored.

**Step 6 — Check proxy settings**
Call `check_proxy_settings` to detect misconfigured system proxies. The tool returns a `proxies[]` array with separate entries per protocol (HTTP, HTTPS, SOCKS, etc.), each with its own `enabled`, `server`, and `port` fields — iterate the array, don't assume a single proxy. A proxy pointing to a non-existent server (e.g. a corporate proxy no longer accessible from home) silently blocks all HTTP/HTTPS traffic while ICMP pings still succeed. If the `anyEnabled` field is true and any enabled proxy looks incorrect, report each offending entry to the user by protocol and ask if they want to disable them. Proxy changes require the user to adjust System Settings manually — this skill does not automate proxy-setting changes.

**Step 7 — Check firewall**
Call `check_firewall_status` to verify the OS firewall is not blocking outbound connections. A "block all connections" firewall state prevents all outbound traffic. Report the status — if `blockAllConnections` is true, this is likely the cause.

**Step 8 — Forget and rejoin Wi-Fi (if Wi-Fi and still failing)**
If the user is on Wi-Fi and all above steps have not resolved the issue, call `forget_wifi_network` with `ssid` set to the current SSID (take it from the `ssid` field returned by `get_wifi_info` in Step 3) and `dryRun: true` to confirm the network is in the saved list. The `ssid` parameter is required — if Step 3 was skipped (because the user is on Ethernet) do not proceed with this step. If the network is found and the user agrees, call `forget_wifi_network` again with the same `ssid` and `dryRun: false`. The G4 consent gate fires automatically (`requiresConsent: true`). Then instruct the user to manually reconnect to the Wi-Fi network by selecting it and entering the password.

**SSID-unavailable fallback (macOS).** On macOS 14.4+, `get_wifi_info` returns `ssidAvailable: false` and `ssid: null` when the agent lacks CoreLocation authorization — Wi-Fi is connected (`isConnected: true`), the OS just refuses to disclose the network name. In this case **do not call `forget_wifi_network`**: the call will fail without the SSID. Instead, instruct the user to forget the network manually: System Settings → Wi-Fi → click "Details" next to the active network → "Forget This Network". The diagnosis (Wi-Fi up, signal `<rssi>`, channel `<channel>`, band `<band>`) is still in the run report for IT.

**Step 9 — Reset network settings (last resort)**
If all other steps fail, call `reset_network_settings` with `dryRun: true` to show the current network locations and what would be reset. Warn the user that custom network configurations (static IPs, manual DNS, VPN profiles) will be removed. If the user confirms, call `reset_network_settings` with `dryRun: false`.

**Step 10 — Final verification**
Call `check_connectivity` one final time to confirm all targets are reachable. Report a summary of all steps taken, what was found, and what was fixed. If the issue persists after all steps, escalate: the problem may be ISP-side, router-side, or require a hardware diagnostic.

---

## Graceful degradation when corrective steps deny

Steps 4 (`renew_dhcp_lease`), 5 (`flush_dns_cache`), 8 (`forget_wifi_network`), and 9 (`reset_network_settings`) require administrator privileges. For non-admin users the G4 scope check returns `outcome: "denied"` and the corrective step does not run — but this does **not** abort the workflow. Continue diagnostic steps to completion; the diagnosis itself is the deliverable.

When a corrective step denies due to insufficient privileges, in the response:

1. **Do not present the denied step as a failure.** State plainly that the step requires admin privileges and the agent could not run it.
2. **Provide a self-service path the user can follow themselves.** Examples:
   - DHCP renew (macOS): System Settings → Wi-Fi → Details on the active network → "Renew DHCP Lease"
   - DHCP renew (Windows): Settings → Network & Internet → Status → "Network reset"
   - DNS flush (Windows): admin Command Prompt → `ipconfig /flushdns`
   - Forget Wi-Fi (macOS): System Settings → Wi-Fi → Details on the saved network → "Forget This Network"
   - Forget Wi-Fi (Windows): Settings → Network & Internet → Wi-Fi → "Manage known networks" → Forget
3. **Tell the user the diagnosis is being packaged for IT escalation** — the support ticket created at the end of the run captures the interface state, signal strength, proxy configuration, and firewall status, so a tier-1 helpdesk can pick up exactly where the agent left off.

---

## Edge cases

- **Router vs device issue** — before running any repair steps, ask the user if other devices on the same network also have no internet. If yes, the issue is the router or ISP, not the device — no amount of device-side repair will fix it
- **Captive portals** — in hotels, airports, or coffee shops, Wi-Fi may show connected but require browser-based login. `check_connectivity` will show all targets as unreachable. Advise the user to open a browser and look for a sign-in page before diagnosing further
- **VPN blocking traffic** — a connected VPN that has lost its tunnel can appear as a network failure. Call `check_vpn_status` if a VPN interface is present — disconnect it and retest before running network reset steps
- **APIPA address (169.254.x.x)** — this always means the DHCP server was unreachable when the interface came up. Could be the router, a DHCP conflict, or the interface initialising before the router was ready. `renew_dhcp_lease` resolves most cases; if it recurs, the router may have a DHCP table full issue
- **DNS vs HTTP(S)** — `check_connectivity` uses ICMP ping. A success means layer 3 routing works. It does not guarantee HTTP/HTTPS works — a firewall may block port 80/443 while allowing ICMP. If ping succeeds but browser fails, `check_proxy_settings` and `check_firewall_status` are the next steps
- **Corporate network with strict firewall** — on a managed corporate network, `reset_network_settings` may remove MDM-pushed configurations. Warn the user before proceeding and suggest contacting IT if they are on a corporate-managed machine
- **IPv6 only issues** — some ISPs have IPv6 problems that affect only certain sites. `check_connectivity` tests IPv4 by default. If all IPv4 targets succeed but the user still cannot reach specific sites, this may be an IPv6 routing issue outside the scope of this skill
