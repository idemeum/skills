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
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - check_connectivity
      - get_network_interfaces
      - get_wifi_info
  maxAggregateRisk: medium
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

Use for: no/intermittent internet, Wi-Fi connected but pages won't load, DNS errors ("server not found", "DNS_PROBE_FINISHED_NXDOMAIN"), network broke after a settings change, or an APIPA address (169.254.x.x = DHCP failure).

Do NOT use for VPN-specific issues — use the `vpn-repair` skill once basic connectivity works.

---

## Steps

**Step 1 — Pre-flight: router-side issue?**
Call `wait_for_user_ack` first — a router/ISP fault looks identical to a device fault in `check_connectivity`, but no device-side repair fixes it.

```yaml
prompt: "Before I run network diagnostics — are other devices on the same Wi-Fi/network having internet problems too?"
options:
  - { id: "just-me",       label: "Just my computer",   kind: "primary" }
  - { id: "other-devices", label: "Other devices too",  kind: "secondary" }
  - { id: "unsure",        label: "I'm not sure",       kind: "secondary" }
```

On `"other-devices"`: router/ISP issue — the read-only diagnostics still run, but **skip corrective Steps 5–6** and conclude the report with *"This is a router or ISP issue — restart your router or contact your ISP."* On `"just-me"` / `"unsure"`: run the full flow. (Don't hard-stop here — the diagnostics are unconditional prereqs and run regardless.)

**Step 2 — Baseline connectivity**
Call `check_connectivity` (default targets 8.8.8.8, 1.1.1.1, google.com). Classify for downstream conditions:
- All unreachable → no connectivity.
- IP targets reachable but `google.com` failing → DNS failure (Step 6).
- Intermittent → unstable link (Step 4 signal check).
- All reachable → layer-3 is up, but ICMP success does NOT prove HTTP(S) works. Do NOT declare success — let Steps 7–8 (proxy/firewall) run first; skip the DHCP/DNS correctives.

**Step 3 — Inspect interfaces**
Call `get_network_interfaces`. `type` and `ipv4` feed Steps 4–5:
- No active interface → hardware/driver issue; stop and escalate.
- Active interface with 169.254.x.x → DHCP failure (Step 5).
- Active interface with valid IPv4 → routing/proxy/firewall (Steps 7–8).

**Step 4 — Wi-Fi signal (if Wi-Fi)**
Call `get_wifi_info`. Poor signal (RSSI < -70 dBm, `linkQuality: "poor"`) explains intermittent drops — advise moving closer to the router before software fixes.
`Condition:` only act on the result if Step 3 returned an active `type: "Wi-Fi"` interface. On Ethernet the tool returns `isConnected: false` cleanly — report "not applicable" and proceed.

**Step 5 — Renew DHCP lease**
Call `renew_dhcp_lease` with `interface` set to the **name of the active interface** from Step 3's `get_network_interfaces` output (e.g. `en0`). **MUST pass `interface` — do NOT omit it.** The corrective runs through the privileged helper, which requires a specific interface (renewing "all" is unsafe on Windows); omitting it makes the helper reject the call. Then re-call `get_network_interfaces` to confirm a valid IP.
`Inputs:` interface name from Step 3's `get_network_interfaces` output (`interfaces[].name` of the active interface).
`Condition:` only if Step 3 shows the active interface has no IPv4 or an APIPA `169.254.` address. Skip on a healthy lease — renew briefly bounces the interface.

**Step 6 — Flush DNS cache**
Call `flush_dns_cache`, then re-call `check_connectivity` on google.com to verify.
`Condition:` only if Step 2 showed IP targets (8.8.8.8, 1.1.1.1) reachable but `google.com` failing. Skip otherwise.

**Step 7 — Check proxy**
Call `check_proxy_settings`. It returns `proxies[]` (per-protocol `enabled`/`server`/`port`) — iterate, don't assume one. A proxy pointing to an unreachable server silently blocks HTTP(S) while ICMP succeeds. If `anyEnabled` and any entry looks wrong, report each by protocol; proxy changes are manual (this skill doesn't automate them).

**Step 8 — Check firewall**
Call `check_firewall_status`. If `blockAllConnections` is true, that's the likely cause.

**Step 9 — Final verification + last-resort guidance**
Call `check_connectivity` once more.
- Reachable → report what was found and fixed; stop.
- Still broken → the remaining options (forget-and-rejoin Wi-Fi, then a full network reset) **sever this device's connection, cutting the agent off from its cloud service mid-run**, so the skill does NOT run them. Present them as manual self-service, in order:
  - **Forget Wi-Fi (macOS):** System Settings → Wi-Fi → "Details…" → "Forget This Network", then reconnect.
  - **Forget Wi-Fi (Windows):** Settings → Network & Internet → Wi-Fi → "Manage known networks" → Forget, then reconnect.
  - **Network reset (macOS):** contact IT, or System Settings → Network (removes custom locations, static IPs, manual DNS, VPN profiles).
  - **Network reset (Windows):** Settings → Network & Internet → Advanced network settings → "Network reset".
  - On an MDM-managed machine a reset may remove IT-pushed config — tell the user to contact IT first.
- Always state the diagnosis (interface, signal, proxy, firewall) is packaged for IT escalation.

---

## Privilege handling

Steps 5–6 need admin. With the helper daemon available (default) they route through it silently for all users. If the helper is unavailable (`denyCategory: helper-unavailable` / `helper-error` / `scope-boundary`), the corrective denies but the diagnosis is still the deliverable — in the response:
1. Don't present the denial as a failure; explain the agent couldn't run the privileged step here.
2. Give the self-service path: DHCP renew (macOS) System Settings → Wi-Fi → Details → "Renew DHCP Lease"; (Windows) `ipconfig /release && ipconfig /renew`. DNS flush (Windows) `ipconfig /flushdns`.
3. Note the diagnosis is packaged for IT escalation.

---

## Edge cases

- **Captive portal** (hotel/airport/café) — Wi-Fi connected but `check_connectivity` shows all unreachable; advise opening a browser to find the sign-in page first.
- **VPN tunnel down** — if Step 3 shows an active `type: "VPN"` interface, advise disconnecting the VPN client manually and retesting; for depth use the `vpn-repair` skill (`check_vpn_status` isn't in this tool set).
- **APIPA recurs** — `renew_dhcp_lease` fixes most; if it keeps returning, the router's DHCP table may be full.
- **IPv6-only** — `check_connectivity` tests IPv4; if IPv4 all succeeds but specific sites fail, suspect an IPv6 routing issue (out of scope).
