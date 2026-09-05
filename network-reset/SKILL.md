---
name: network-reset
description: Diagnoses and repairs network connectivity issues including no internet access, Wi-Fi problems, DNS failures, DHCP lease errors, misconfigured proxies, and corrupt network settings. Use when user has no or intermittent internet access.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - survey_network
  - check_connectivity
  - renew_dhcp_lease
  - flush_dns_cache
  - check_proxy_settings
  - disable_proxy
  - check_firewall_status
  - c_mdm_diagnose_configuration
  - c_mdm_reapply_configuration
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - survey_network
  # Raised from medium when the MDM branch landed: c_mdm_reapply_configuration
  # is riskLevel high, and G2 blocks the whole plan when any step exceeds this
  # ceiling. The local correctives remain medium; the high step is the MDM
  # re-apply, which is consent-gated and non-destructive.
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

On `"other-devices"`: router/ISP issue — the read-only diagnostics still run, but **skip corrective Steps 3, 4 and 7** and conclude the report with *"This is a router or ISP issue — restart your router or contact your ISP."* On `"just-me"` / `"unsure"`: run the full flow. (Don't hard-stop here — the diagnostics are unconditional prereqs and run regardless.)

**Step 2 — Survey the connection**
Call `survey_network`. One call returns reachability, every interface, the active uplink and Wi-Fi link quality. Read from it:
- `allReachable` / `anyReachable` / `targets[]` — the reachability picture. All unreachable → no connectivity. IP targets reachable but `google.com` failing → DNS failure (Step 4). All reachable → layer-3 is up, but ICMP success does NOT prove HTTP(S) works: do not declare success, let the proxy and firewall steps run, and skip the DHCP/DNS correctives.
- `targetInterface` — the interface every corrective acts on. The tool applies the selection rule (default-route uplink, else the first active Wi-Fi or Ethernet interface, never loopback or a peer-to-peer link), so use this value directly and do NOT re-derive it from `interfaces[]`. Null means nothing on this machine can carry traffic — a hardware or driver fault; stop and escalate.
- `hasApipa` — true when the target holds a `169.254.x.x` self-assigned address, the signature of a DHCP failure (Step 3).
- `wifi` — link detail, present only when the uplink is Wi-Fi. `rssi` below -70 dBm or `linkQuality: "poor"` explains intermittent drops; advise moving closer to the router before applying software fixes. Null means the uplink is not Wi-Fi — report "not applicable", never "poor".

**Step 3 — Renew DHCP lease**
Call `renew_dhcp_lease` with `interface` set to Step 2's `targetInterface`. **MUST pass `interface` — do NOT omit it.** The corrective runs through the privileged helper, which requires a specific interface (renewing "all" is unsafe on Windows); omitting it makes the helper reject the call. The tool reports what it achieved: `acquired: true` with a `new_ip` means the lease landed, and `acquired: false` with no error means the request was accepted but no address had arrived yet — not yet confirmed, not a failure. Read those instead of re-reading the interface.
`inputsFrom:` `[{ step: 2, field: "targetInterface" }]`
`Condition:` only if Step 2 returned `hasApipa: true` or a null `targetIpv4`. Skip on a healthy lease — a renew briefly bounces the interface.

**Step 4 — Flush DNS cache**
Call `flush_dns_cache`.
`Condition:` only if Step 2 showed IP targets (8.8.8.8, 1.1.1.1) reachable but `google.com` failing. Skip otherwise.

**Step 5 — Check proxy**
Call `check_proxy_settings`. It returns `proxies[]` (per-protocol `enabled`/`server`/`port`) — iterate, don't assume one. A proxy pointing to an unreachable server silently blocks HTTP(S) while ICMP succeeds. Report each enabled entry by protocol.

**Step 6 — Is the proxy server itself reachable?**
`Condition:` only run if Step 5 returned `anyEnabled: true` with at least one entry carrying a `server`. Call `check_connectivity` targeting that proxy's `server`. This is what separates "a proxy is configured" (normal on a corporate network) from "a proxy is configured and dead" (the fault). Do NOT offer Step 7 on a reachable proxy — a working corporate proxy must stay on.

**Step 7 — Switch off an unreachable proxy**
`Condition:` only run if Step 6 showed the proxy server unreachable. Call `disable_proxy` with `interface` set to the network **service** name for Step 2's `targetInterface` — on macOS that is the label from System Settings → Network (`"Wi-Fi"`, `"Ethernet"`), not the BSD device (`en0`). Pass `protocols` limited to the kinds Step 5 reported as enabled.

G4 fires the dry-run preview then the consent gate. Be accurate in the rationale: this switches the proxy **off** and leaves the server and port configured, so the user can turn it back on from System Settings when they are back on the network that needs it. Say that explicitly — a user who thinks they are losing their corporate proxy address will decline.

**Step 8 — Check firewall**
Call `check_firewall_status`. If `blockAllConnections` is true, that's the likely cause.

**Step 9 — Check the device's MDM configuration**
`Condition:` only run if Step 2's `survey_network` returned `allReachable: false`. A machine that reached every target has no connectivity fault for a configuration profile to explain — there is nothing here for MDM to fix, so this step and Steps 10–12 do not run. Do NOT read this as "connectivity is still broken after the correctives": when Steps 3, 4 and 7 were themselves skipped, nothing changed and Step 2's reading is still the current one.

Call `c_mdm_diagnose_configuration`. It reads enrollment, locates the device in the tenant, and returns the per-profile configuration states in one call. Every eligibility rule — reachable provider, readable serial, exactly one matching device, checked in within 7 days, at least one profile in `failed` — is enforced inside the tool, so do not re-derive them here.

Only `outcome: "failed-items"` continues. On anything else, skip Steps 10–11 and report the tool's `message` — it is already written for the user. Two deserve emphasis: on `stale-checkin` lead with the check-in age, because a device that fell off management is more useful to IT than any symptom; on `ambiguous-serial` say plainly that nothing was acted on. On `not-enrolled` or `other-provider`, name the provider so the escalation is actionable.

On `failed-items`, name them from `failedItems` — that is what makes the escalation actionable — and judge relevance yourself, which the tool deliberately does not: a Wi-Fi payload speaks to the signal or DHCP symptom and a proxy payload to the proxy symptom, while an unrelated failing profile is worth reporting but does not justify a re-apply.

**Step 10 — Re-apply the device's configuration**
`Condition:` only run if Step 9 returned `reapplyWarranted: true` AND at least one profile in `failedItems` plausibly explains the diagnosed network fault.


Call `c_mdm_reapply_configuration`. State plainly in the rationale that this tells the device to check in and re-apply **all** its assigned configuration — it is not a targeted re-push of one profile (no such operation exists), it creates and changes no policy, and it completes asynchronously after the tool returns.

**Step 11 — Wait for the policy to land**
`Condition:` only run if Step 10 returned `status: "ok"`. Call `wait_for_user_ack`:

```yaml
prompt: "I've asked Intune to re-send your device's configuration. That usually takes a minute or two. Tell me when to re-test."
options:
  - { id: "ready", label: "Ready — re-test now", kind: "primary" }
  - { id: "skip",  label: "Skip the re-test",    kind: "cancel" }
```

On `skip`, report the sync as initiated but unverified.

**Step 12 — Re-test, if anything was actually changed**
`Condition:` only run if a corrective actually ran — Step 3 (`renew_dhcp_lease`), Step 4 (`flush_dns_cache`), Step 7 (`disable_proxy`) or Step 10 (`c_mdm_reapply_configuration`). Skip when none of them fired: nothing on the device changed, so Step 2's result still stands and re-probing only repeats a measurement already taken.

Call `check_connectivity` once more and compare against Step 2.

**Step 13 — Final report**
Report what was found and what, if anything, was fixed. Be precise about which reading you are quoting: Step 12's re-test when a corrective ran, otherwise Step 2's original result — never imply a fresh check happened when Step 12 was skipped.
- Reachable → report what was found and fixed; stop.
- Still broken → the remaining options (forget-and-rejoin Wi-Fi, then a full network reset) **sever this device's connection, cutting the agent off from its cloud service mid-run**, so the skill does NOT run them. Present them as manual self-service, in order:
  - **Forget Wi-Fi (macOS):** System Settings → Wi-Fi → "Details…" → "Forget This Network", then reconnect.
  - **Forget Wi-Fi (Windows):** Settings → Network & Internet → Wi-Fi → "Manage known networks" → Forget, then reconnect.
  - **Network reset (macOS):** contact IT, or System Settings → Network (removes custom locations, static IPs, manual DNS, VPN profiles).
  - **Network reset (Windows):** Settings → Network & Internet → Advanced network settings → "Network reset".
  - On an MDM-managed machine a reset may remove IT-pushed config — tell the user to contact IT first.
- Always state the diagnosis (interface, signal, proxy, firewall, and any failing MDM profile from Step 11) is packaged for IT escalation.

---

## Privilege handling

Steps 3, 4 and 7 need admin. With the helper daemon available (default) they route through it silently for all users. If the helper is unavailable (`denyCategory: helper-unavailable` / `helper-error` / `scope-boundary`), the corrective denies but the diagnosis is still the deliverable — in the response:
1. Don't present the denial as a failure; explain the agent couldn't run the privileged step here.
2. Give the self-service path: DHCP renew (macOS) System Settings → Wi-Fi → Details → "Renew DHCP Lease"; (Windows) `ipconfig /release && ipconfig /renew`. DNS flush (Windows) `ipconfig /flushdns`.
3. Note the diagnosis is packaged for IT escalation.

---

## Edge cases

- **Captive portal** (hotel/airport/café) — Wi-Fi connected but `check_connectivity` shows all unreachable; advise opening a browser to find the sign-in page first.
- **VPN tunnel down** — if Step 3 shows an active `type: "VPN"` interface, advise disconnecting the VPN client manually and retesting; for depth use the `vpn-repair` skill (`check_vpn_status` isn't in this tool set).
- **APIPA recurs** — `renew_dhcp_lease` fixes most; if it keeps returning, the router's DHCP table may be full.
- **IPv6-only** — `check_connectivity` tests IPv4; if IPv4 all succeeds but specific sites fail, suspect an IPv6 routing issue (out of scope).
