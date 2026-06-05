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
  - wait_for_user_ack
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

**Step 1 — Pre-flight: router-side issue?**
Call `wait_for_user_ack` to determine whether the problem is device-side or network-side before running any diagnostic tools. A router/ISP issue will look exactly like a device issue from `check_connectivity`'s output, but no device-side repair can fix it.

```yaml
prompt: "Before I run network diagnostics — are other devices on the same Wi-Fi/network having internet problems too? This helps me know whether to dig into your computer or skip to a router/ISP issue."
options:
  - { id: "just-me",      label: "Just my computer",   kind: "primary" }
  - { id: "other-devices", label: "Other devices too", kind: "secondary" }
  - { id: "unsure",       label: "I'm not sure",       kind: "secondary" }
```

If `choice === "other-devices"`, report: *"This is a router or ISP issue — no device-side repair will help. Try restarting your router, or contact your ISP if the problem persists."* End the run. Do NOT proceed to Step 2. For `"just-me"` or `"unsure"`, continue with the diagnostic flow.

**Step 2 — Baseline connectivity check**
Call `check_connectivity` with default targets (8.8.8.8, 1.1.1.1, google.com). This classifies the failure for the downstream `Condition:` clauses (which skip irrelevant steps automatically):
- All targets unreachable → no connectivity at all (Steps 3, 5, 9, 11 will engage as needed)
- IP targets reachable but `google.com` not → DNS failure (Step 6's Condition matches)
- Intermittent failures → unstable connection (Step 4's Wi-Fi signal check is the first lead)
- All targets reachable → connectivity is actually fine; the user's issue may be app-specific. Report and stop — do not run corrective steps.

`Condition:` only run if Step 1's `wait_for_user_ack` returned `choice !== "other-devices"`. Skip the entire downstream flow on `"other-devices"` (already ended above).

**Step 3 — Inspect network interfaces**
Call `get_network_interfaces` to list all interfaces and their status. The interface-type and IPv4-address fields feed Steps 4, 5, and 9 via their `Condition:` clauses. Reportable classifications:
- No active interface (all down) → hardware/driver issue; stop and escalate
- Active interface with 169.254.x.x IPv4 → DHCP failure (Step 5 will engage)
- Active interface with valid IPv4 → routing/proxy/firewall issue (Steps 7, 8 will engage)
- Active Wi-Fi interface → Step 4 will check signal regardless of address state

**Step 4 — Check Wi-Fi signal (if Wi-Fi)**
Call `get_wifi_info` to check signal strength and channel. A poor signal (RSSI below -70 dBm, linkQuality "poor") explains intermittent connectivity — advise the user to move closer to the router before attempting software fixes.

`Condition:` only act on the result if Step 3's `get_network_interfaces` returns an active interface with `type: "Wi-Fi"` (the literal returned by the tool). On Ethernet, `get_wifi_info` returns `isConnected: false` cleanly; just report "not applicable — interface is Ethernet" and proceed.

**Step 5 — Renew DHCP lease**
Call `renew_dhcp_lease` to release and renew the IP address. After renewal, call `get_network_interfaces` again to confirm a valid IP was assigned.

`Condition:` only run if Step 3's `get_network_interfaces` shows the active interface has either no IPv4 address or an APIPA address (IPv4 starts with `169.254.`). Skip if the interface already has a valid public/private IP — DHCP renew is disruptive (interface bounces briefly) and pointless when the lease is healthy.

**Step 6 — Flush DNS cache**
Call `flush_dns_cache` to clear stale DNS entries. After flushing, call `check_connectivity` again using google.com to verify DNS resolution is restored.

`Condition:` only run if Step 2's `check_connectivity` shows the IP-only targets (`8.8.8.8`, `1.1.1.1`) reachable but the hostname target (`google.com`) failing — that's the DNS-resolution-broken signature. Skip if all targets reachable (nothing to fix) or all targets unreachable (it's not DNS, it's connectivity).

**Step 7 — Check proxy settings**
Call `check_proxy_settings` to detect misconfigured system proxies. The tool returns a `proxies[]` array with separate entries per protocol (HTTP, HTTPS, SOCKS, etc.), each with its own `enabled`, `server`, and `port` fields — iterate the array, don't assume a single proxy. A proxy pointing to a non-existent server (e.g. a corporate proxy no longer accessible from home) silently blocks all HTTP/HTTPS traffic while ICMP pings still succeed. If the `anyEnabled` field is true and any enabled proxy looks incorrect, report each offending entry to the user by protocol and ask if they want to disable them. Proxy changes require the user to adjust System Settings manually — this skill does not automate proxy-setting changes.

**Step 8 — Check firewall**
Call `check_firewall_status` to verify the OS firewall is not blocking outbound connections. A "block all connections" firewall state prevents all outbound traffic. Report the status — if `blockAllConnections` is true, this is likely the cause.

**Step 9 — Forget Wi-Fi (if Wi-Fi and still failing)**
Call `forget_wifi_network` with `ssid` set to the current SSID. The `ssid` parameter is required. G4 auto-triggers the dry-run preview (`tool.meta.destructive: true` + `supportsDryRun: true`); if the user accepts, the consent gate fires (`tool.meta.requiresConsent: true`) and the corrective call runs.

`inputsFrom: [{ step: 4, field: "ssid" }]`

`Condition:` only run if (a) Step 3's `get_network_interfaces` shows the active interface has `type: "Wi-Fi"`, (b) Step 4's `get_wifi_info` returned a non-null, non-empty `ssid` (see SSID-unavailable fallback below for the macOS 14.4+ case where `ssidAvailable: false`), and (c) the most recent `check_connectivity` result in scratchpad (Step 2's baseline, or any re-check Steps 5/6 may have triggered) still shows `allReachable: false`. Skip silently otherwise — do NOT invent an SSID or call with an empty value.

**SSID-unavailable fallback (macOS).** On macOS 14.4+, `get_wifi_info` returns `ssidAvailable: false` and `ssid: null` when the agent lacks CoreLocation authorization — Wi-Fi is connected (`isConnected: true`), the OS just refuses to disclose the network name. In this case **do not call `forget_wifi_network`**: the call will fail without the SSID. Instead, instruct the user (in the Step 9 rationale) to forget the network manually: System Settings → Wi-Fi → click "Details" next to the active network → "Forget This Network". Step 10's `wait_for_user_ack` then waits for the user to complete both the forget and the reconnect. The diagnosis (Wi-Fi up, signal `<rssi>`, channel `<channel>`, band `<band>`) is still in the run report for IT.

**Step 10 — Wait for user to reconnect to Wi-Fi**
After Step 9 forgets the saved network (or the user does it manually via the macOS SSID-unavailable fallback), the user must reconnect by selecting the network and entering the password. This is out-of-band — the agent cannot observe the reconnect. Call `wait_for_user_ack` to pause until the user confirms:

```yaml
prompt: "I've forgotten the saved Wi-Fi network (or asked you to do it manually). Reconnect by selecting the network and entering the password, then let me know when you're back online."
options:
  - { id: "reconnected",    label: "I'm reconnected",        kind: "primary" }
  - { id: "couldnt-connect", label: "Couldn't reconnect",    kind: "secondary" }
  - { id: "skip",           label: "Skip — not on Wi-Fi",    kind: "cancel" }
```

`Condition:` only run if Step 9 ran OR the macOS SSID-unavailable fallback was followed. Skip otherwise. Without this gate, Step 11's `reset_network_settings` Condition will match prematurely (connectivity still broken because the user is mid-reconnect) and fire while the user is still typing their Wi-Fi password.

**Step 11 — Reset network settings (last resort)**
Call `reset_network_settings`. G4 auto-triggers the dry-run preview (`tool.meta.riskLevel: "high"` + `destructive: true` + `supportsDryRun: true`), which surfaces the current network locations and what would be reset; the consent gate then fires (`tool.meta.requiresConsent: true`). Warn the user in your rationale that custom network configurations (static IPs, manual DNS, VPN profiles) will be removed.

`Condition:` only run if (a) Step 10 either was skipped or returned `choice === "couldnt-connect"`, AND (b) the most recent `check_connectivity` result in scratchpad (Step 2's baseline, or any re-check Steps 5/6 may have triggered, or any post-Step-10 re-check) still shows targets unreachable. Skip if Step 10 returned `"reconnected"` and the user's manual reconnect resolved the issue — the reset is destructive and unnecessary when the issue is already fixed.

**Step 12 — Final verification**
Call `check_connectivity` one final time to confirm all targets are reachable. Report a summary of all steps taken, what was found, and what was fixed. If the issue persists after all steps, escalate: the problem may be ISP-side, router-side, or require a hardware diagnostic.

---

## Privilege handling — helper-routed (default) vs. fallback

Steps 5 (`renew_dhcp_lease`), 6 (`flush_dns_cache`), 9 (`forget_wifi_network`), and 11 (`reset_network_settings`) require administrator privileges to execute the underlying OS commands. The agent handles this transparently in two modes:

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): the agent routes these steps through the helper daemon and they complete silently for **all users — admin and non-admin alike**. The user sees the step succeed; the diagnosis is the corrective step. No "this requires admin" messaging is needed in the response.

**When the helper is unavailable** (`HELPER_DAEMON_ENABLED=false`, helper not installed, or helper unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`): the corrective step denies and the diagnostic continues to completion — the diagnosis itself is still the deliverable. In this fallback case, in the response:

1. **Do not present the denied step as a failure.** State plainly that the agent couldn't complete the privileged step on this device and explain why (helper unavailable / not enabled / non-admin user).
2. **Provide a self-service path the user can follow themselves.** Examples:
   - DHCP renew (macOS): System Settings → Wi-Fi → Details on the active network → "Renew DHCP Lease"
   - DHCP renew (Windows): Settings → Network & Internet → Status → "Network reset"
   - DNS flush (Windows): admin Command Prompt → `ipconfig /flushdns`
   - Forget Wi-Fi (macOS): System Settings → Wi-Fi → Details on the saved network → "Forget This Network"
   - Forget Wi-Fi (Windows): Settings → Network & Internet → Wi-Fi → "Manage known networks" → Forget
3. **Tell the user the diagnosis is being packaged for IT escalation** — the support ticket captures the interface state, signal strength, proxy configuration, and firewall status, so a tier-1 helpdesk can pick up exactly where the agent left off. IT can also investigate why the helper is unavailable on this device.

---

## Edge cases

- **Router vs device issue** — handled by Step 1's `wait_for_user_ack` pre-flight ack. If the user reports other devices are also affected, the skill ends immediately with a router/ISP escalation recommendation
- **Captive portals** — in hotels, airports, or coffee shops, Wi-Fi may show connected but require browser-based login. `check_connectivity` will show all targets as unreachable. Advise the user to open a browser and look for a sign-in page before diagnosing further
- **VPN blocking traffic** — a connected VPN that has lost its tunnel can appear as a network failure. If Step 2's `get_network_interfaces` shows an active interface with `type: "VPN"`, advise the user to disconnect the VPN client manually and retest connectivity before running corrective network steps. For a deeper diagnosis, escalate to the `vpn-repair` skill — `check_vpn_status` is not part of this skill's tool set
- **APIPA address (169.254.x.x)** — this always means the DHCP server was unreachable when the interface came up. Could be the router, a DHCP conflict, or the interface initialising before the router was ready. `renew_dhcp_lease` resolves most cases; if it recurs, the router may have a DHCP table full issue
- **DNS vs HTTP(S)** — `check_connectivity` uses ICMP ping. A success means layer 3 routing works. It does not guarantee HTTP/HTTPS works — a firewall may block port 80/443 while allowing ICMP. If ping succeeds but browser fails, `check_proxy_settings` and `check_firewall_status` are the next steps
- **Corporate network with strict firewall** — on a managed corporate network, `reset_network_settings` may remove MDM-pushed configurations. Warn the user before proceeding and suggest contacting IT if they are on a corporate-managed machine
- **IPv6 only issues** — some ISPs have IPv6 problems that affect only certain sites. `check_connectivity` tests IPv4 by default. If all IPv4 targets succeed but the user still cannot reach specific sites, this may be an IPv6 routing issue outside the scope of this skill
