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
  - disable_proxy
  - check_firewall_status
  - check_mdm_enrollment
  - c_intune_find_device
  - c_intune_get_configuration_states
  - c_intune_sync_device
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - check_connectivity
      - get_network_interfaces
      - get_wifi_info
  # Raised from medium when the MDM branch landed: c_intune_sync_device is
  # riskLevel high, and G2 blocks the whole plan when any step exceeds this
  # ceiling. The local correctives remain medium; the high step is the Intune
  # re-sync, which is consent-gated and non-destructive.
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
- All reachable → layer-3 is up, but ICMP success does NOT prove HTTP(S) works. Do NOT declare success — let Steps 7–10 (proxy/firewall) run first; skip the DHCP/DNS correctives.

**Step 3 — Inspect interfaces**
Call `get_network_interfaces` → `primaryInterface` (the default-route uplink — the deterministic "which interface is my connection"; do NOT hand-scan `interfaces[]`), `interfaces[]` (`name`/`type`/`status`/`ipv4`), `activeCount`. The **target interface** for Steps 4–5 is `primaryInterface` when non-null; if `primaryInterface` is null (no default route), fall back to the active physical interface (`status === "active"` AND `type` is `"Wi-Fi"` or `"Ethernet"` — ignore loopback, tunnels, `awdl0`/`llw0`). Classify:
- `primaryInterface` null AND no active physical interface → hardware/driver issue or link fully down; stop and escalate.
- Target interface has `169.254.x.x` or no IPv4 → DHCP failure (Step 5).
- Target interface has a valid (non-`169.254`) IPv4 → routing/proxy/firewall (Steps 7–10).

**Step 4 — Wi-Fi signal (if Wi-Fi)**
Call `get_wifi_info`. Poor signal (RSSI < -70 dBm, `linkQuality: "poor"`) explains intermittent drops — advise moving closer to the router before software fixes.
`Condition:` only act on the result if Step 3 returned an active `type: "Wi-Fi"` interface. On Ethernet the tool returns `isConnected: false` cleanly — report "not applicable" and proceed.

**Step 5 — Renew DHCP lease**
Call `renew_dhcp_lease` with `interface` set to Step 3's **target interface** — `primaryInterface` when set, otherwise the active physical interface (`status: "active"`, `type` `Wi-Fi`/`Ethernet`); in the APIPA case `primaryInterface` is usually null, so use the active physical interface. **MUST pass `interface` — do NOT omit it.** The corrective runs through the privileged helper, which requires a specific interface (renewing "all" is unsafe on Windows); omitting it makes the helper reject the call. The helper returns `new_ip: null` (it does not probe), so **re-call `get_network_interfaces` afterward and confirm the target interface now has a valid non-`169.254` IPv4** — that re-check, not the corrective's own result, is the success signal.
`inputsFrom:` `[{ step: 3, field: "primaryInterface" }]` (fall back to the active physical `interfaces[].name` when null).
`Condition:` only if Step 3's target interface has no IPv4 or an APIPA `169.254.` address. Skip on a healthy lease — renew briefly bounces the interface.

**Step 6 — Flush DNS cache**
Call `flush_dns_cache`, then re-call `check_connectivity` on google.com to verify.
`Condition:` only if Step 2 showed IP targets (8.8.8.8, 1.1.1.1) reachable but `google.com` failing. Skip otherwise.

**Step 7 — Check proxy**
Call `check_proxy_settings`. It returns `proxies[]` (per-protocol `enabled`/`server`/`port`) — iterate, don't assume one. A proxy pointing to an unreachable server silently blocks HTTP(S) while ICMP succeeds. Report each enabled entry by protocol.

**Step 8 — Is the proxy server itself reachable?**
`Condition:` only run if Step 7 returned `anyEnabled: true` with at least one entry carrying a `server`. Call `check_connectivity` targeting that proxy's `server`. This is what separates "a proxy is configured" (normal on a corporate network) from "a proxy is configured and dead" (the fault). Do NOT offer Step 9 on a reachable proxy — a working corporate proxy must stay on.

**Step 9 — Switch off an unreachable proxy**
`Condition:` only run if Step 8 showed the proxy server unreachable. Call `disable_proxy` with `interface` set to the network **service** name for Step 3's target interface — on macOS that is the label from System Settings → Network (`"Wi-Fi"`, `"Ethernet"`), not the BSD device (`en0`). Pass `protocols` limited to the kinds Step 7 reported as enabled.

G4 fires the dry-run preview then the consent gate. Be accurate in the rationale: this switches the proxy **off** and leaves the server and port configured, so the user can turn it back on from System Settings when they are back on the network that needs it. Say that explicitly — a user who thinks they are losing their corporate proxy address will decline.

**Step 10 — Check firewall**
Call `check_firewall_status`. If `blockAllConnections` is true, that's the likely cause.

**Step 11 — Is this device MDM-managed?**
`Condition:` only run if Step 2's `check_connectivity` returned `allReachable: false`. A machine that reached every target has no connectivity fault for a configuration profile to explain — there is nothing here for MDM to fix, so this step and Steps 12–16 do not run. Do NOT read this as "connectivity is still broken after the correctives": when Steps 5–7 were themselves skipped, nothing changed and Step 2's reading is still the current one.

Call `check_mdm_enrollment`. Continue to Step 12 ONLY when `isEnrolled` is true, `serialNumber` is non-null, and `mdmProvider` is Intune. Otherwise skip Steps 12–15 and go to Step 17, stating which of these it was: not enrolled; managed by another provider (name it — a Jamf Mac is not reachable from here yet); or serial unreadable (common on VMs).

**Step 12 — Locate the device in Intune**
`Condition:` only run if Step 11 continued. Call `c_intune_find_device` — takes no parameters, the serial comes from the runtime.

Check `matchCount` first. Continue ONLY when it is exactly 1; otherwise skip to Step 17. `0` means not in this tenant. `>1` means the serial is ambiguous — VM templates and some OEM batches ship duplicates — so the record returned may be a different machine; **act on none of them**, and say IT must identify the right one.

With one match, check `lastCheckIn`. If the device last contacted Intune more than **7 days** ago it is not collecting policy at all, so a re-sync will sit unacknowledged and the wait would be spent for nothing — skip Steps 13–15, report the stale check-in date as the finding, and escalate. That date is more useful to IT than any symptom: it says the device fell off management, not that a profile is wrong.

**Step 13 — Which profile failed?**
`Condition:` only run if Step 12 found the device. Call `c_intune_get_configuration_states`. Name the specific failing profile — a Wi-Fi payload for Step 4's symptom, a proxy payload for Step 7's. Report it by name even if Step 14 is skipped; that is what makes the escalation actionable.

**Step 14 — Re-apply the device's configuration**
`Condition:` only run if Step 13 shows a profile whose `state` is `failed` and which matches the diagnosed fault. **Only `failed` warrants a sync.** `pending` and `deferred` mean the device has the command and has not finished with it — syncing again just re-queues it. `conflict` means two policies disagree, which IT must resolve; a sync cannot. `applied` means the fault lies elsewhere.

Call `c_intune_sync_device`. State plainly in the rationale that this tells the device to check in and re-apply **all** its assigned configuration — it is not a targeted re-push of one profile (no such operation exists), it creates and changes no policy, and it completes asynchronously after the tool returns.

**Step 15 — Wait for the policy to land**
`Condition:` only run if Step 14 returned `status: "initiated"`. Call `wait_for_user_ack`:

```yaml
prompt: "I've asked Intune to re-send your device's configuration. That usually takes a minute or two. Tell me when to re-test."
options:
  - { id: "ready", label: "Ready — re-test now", kind: "primary" }
  - { id: "skip",  label: "Skip the re-test",    kind: "cancel" }
```

On `skip`, report the sync as initiated but unverified.

**Step 16 — Re-test, if anything was actually changed**
`Condition:` only run if a corrective actually ran — Step 5 (`renew_dhcp_lease`), Step 6 (`flush_dns_cache`), Step 9 (`disable_proxy`) or Step 14 (`c_intune_sync_device`). Skip when none of them fired: nothing on the device changed, so Step 2's result still stands and re-probing only repeats a measurement already taken.

Call `check_connectivity` once more and compare against Step 2.

**Step 17 — Final report**
Report what was found and what, if anything, was fixed. Be precise about which reading you are quoting: Step 16's re-test when a corrective ran, otherwise Step 2's original result — never imply a fresh check happened when Step 16 was skipped.
- Reachable → report what was found and fixed; stop.
- Still broken → the remaining options (forget-and-rejoin Wi-Fi, then a full network reset) **sever this device's connection, cutting the agent off from its cloud service mid-run**, so the skill does NOT run them. Present them as manual self-service, in order:
  - **Forget Wi-Fi (macOS):** System Settings → Wi-Fi → "Details…" → "Forget This Network", then reconnect.
  - **Forget Wi-Fi (Windows):** Settings → Network & Internet → Wi-Fi → "Manage known networks" → Forget, then reconnect.
  - **Network reset (macOS):** contact IT, or System Settings → Network (removes custom locations, static IPs, manual DNS, VPN profiles).
  - **Network reset (Windows):** Settings → Network & Internet → Advanced network settings → "Network reset".
  - On an MDM-managed machine a reset may remove IT-pushed config — tell the user to contact IT first.
- Always state the diagnosis (interface, signal, proxy, firewall, and any failing MDM profile from Step 13) is packaged for IT escalation.

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
