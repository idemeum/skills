---
name: vpn-repair
description: Diagnoses and repairs VPN connectivity issues including stale connections, misconfigured profiles, expired certificates, missing network extensions, and DNS leaks. Use when user cannot connect to VPN or VPN appears connected but traffic is not routing.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_vpn_status
  - get_vpn_profiles
  - check_connectivity
  - check_certificate_expiry
  - check_network_extension
  - reconnect_vpn
  - flush_dns_cache
  - wait_for_user_ack
  - request_user_input
metadata:
  prerequisites:
    before-corrective:
      - check_vpn_status
      - get_vpn_profiles
      - check_connectivity
      - check_certificate_expiry
      - check_network_extension
  maxAggregateRisk: medium
  userLabel: "VPN not connecting"
  examples:
    - "my VPN won't connect"
    - "VPN is connected but I can't access company resources"
    - "VPN keeps disconnecting"
    - "I can't connect to the company VPN"
    - "VPN connection fails every time I try"
  pill:
    label: Fix VPN
    goal: My VPN is not connecting or traffic is not routing through it, please diagnose and fix it
    icon: Lock
    iconClass: text-teal-500
    order: 8
---

## When to use

VPN won't connect / drops immediately; shows "Connected" but internal resources unreachable; cert or auth errors on connect; broke after an OS update.

Do NOT use if there's **no internet at all** — run the `network-reset` skill first, then retry VPN.

---

## Steps

**Step 1 — VPN status**
`check_vpn_status` → `activeConnections[]` (`name`, `status`), `isConnected`, `installedClients[]` (vendor clients by process, e.g. "Cisco AnyConnect", "Palo Alto GlobalProtect"). Tells you if the target is a **native profile** or a **vendor client**.

**Step 2 — VPN profiles**
`get_vpn_profiles` → on macOS: native scutil profiles; on Windows: native RAS-registered profiles (IKEv2/SSTP/PPTP) **plus** vendor-managed entries for any running third-party client (ProtonVPN, NordVPN, Mullvad, Tailscale, etc.) that does not register via the Windows VPN stack. Vendor-managed entries have `type: "vendor-managed"` — `reconnect_vpn` cannot drive them; Step 9 will return `vendorManaged` and guide the user to the vendor app. Vendor clients also surface via Step 1's `installedClients`.

**Step 3 — Base internet**
`check_connectivity` (8.8.8.8, 1.1.1.1, google.com). No internet at all → VPN can't connect; switch to `network-reset`.

**Step 4 — VPN server reachability**
`check_connectivity` with the VPN server hostname as target. `Condition:` only if Step 3 showed internet up AND Step 1 showed VPN NOT connected. Skip if already connected (Step 9 handles "connected but not routing") or internet is down.

**Step 5 — Certificate (SSL/TLS VPNs only)**
`Condition:` only for **SSL/TLS VPNs** — Step 2's `profiles[].protocol` (or Step 1's vendor client) indicates SSL/TLS, e.g. AnyConnect, GlobalProtect, Zscaler. **Skip entirely for WireGuard / IKEv2 / IPsec / L2TP** — they authenticate with keys/PSK, not a TLS server cert, so this probe is meaningless (and their native port has no TLS listener).
Call `check_certificate_expiry` with `host` = the VPN server **hostname only** (`inputsFrom: [{ step: 2, field: "profiles" }]`, `profiles[].server`; **strip any `:port`**), `port: 443`, `fallbackPorts: [8443]`. **Use TLS ports only — never the VPN's own connection port (e.g. WireGuard 51821, IKEv2 500/4500); probing it returns `ECONNREFUSED`, not a cert.**
**If the result has an `error` field, the probe couldn't read a cert (port blocked / not a TLS VPN) — inconclusive, NOT expired; only trust `isExpired` when `error` is absent.** Client certs expire separately and can't be checked here — ask if the user got a renewal notice.

**Step 6 — Network extensions (survey all)**
`check_network_extension` with **no argument** — lists every VPN/security extension (system + app). Do NOT pass a vendor name; the survey returns all and Step 7 inspects them. Entries have `name`/`identifier`/`state`/`type`; result also carries `allActivated`.

**Step 7 — Approve extension (macOS only)**
Approval is out-of-band, so gate on it. `wait_for_user_ack`:

```yaml
prompt: "Your VPN client's network extension '{name}' needs approval. Open System Settings → Privacy & Security, find it, and click Allow. Tell me when done."
options:
  - { id: "approved",  label: "I approved it",             kind: "primary" }
  - { id: "blocked",   label: "It's blocked by MDM",       kind: "secondary" }
  - { id: "not-there", label: "I don't see the extension", kind: "secondary" }
```

`Condition:` only on `darwin` AND Step 6 shows a pending extension — `allActivated === false` AND some `extensions[].state` includes `"waiting for user"`. Substitute `{name}` from that extension. On `"blocked"` → IT (MDM policy); `"not-there"` → VPN-client reinstall (software-reinstall skill); proceed only on `"approved"`.

**Step 8 — Pick native profile (if multiple)**
`Condition:` only if Step 2 returned `profiles.length > 1`. `wait_for_user_ack`, one option per profile (top 4 by MRU else alphabetical; 4th = "Other (tell me in chat)" if more). `inputsFrom: [{ step: 2, field: "profiles" }]`. `"other"` → `request_user_input` for the exact name. One profile → use directly; zero → Step 9's vendor path.

**Step 9 — Reconnect**
Call `reconnect_vpn` with `profileName` — `inputsFrom`: Step 8 if it ran (`{ step: 8, field: "choice" }`), else the single profile (`{ step: 2, field: "profiles" }`); fallback if Step 2 was empty, Step 1's `activeConnections[].name`. Pass ONLY `profileName` — do **NOT** author a `dryRun` param; G4 owns the dry-run preview + consent gates and an injected `dryRun: true` would silently no-op the reconnect. **Warn in the rationale:** *"if your VPN carries all traffic, you may briefly lose contact with me while it reconnects — I'll resume once you're back."*

The tool **waits for the tunnel to settle** before returning, so trust its result: `reconnected === true` AND `newStatus === "Connected"` is a real success → continue to Step 11. If `reconnected === false` (e.g. `newStatus` is `"Connecting"`/`"Disconnected"`), the tunnel did NOT come up — surface the returned `message` verbatim, do **NOT** run Steps 11–13, and go to Step 10 (let the user finish any sign-in / MFA) or escalate to IT.

`Condition:` (a) Step 1 `isConnected === true` with an `activeConnections[]` entry `status` `"Connected"`/`"Active"` and the symptom is "connected but resources unreachable", OR (b) Steps 4–6 surfaced a fixable issue (server reachable, cert OK/inconclusive, extension approved). Skip and escalate to IT if Steps 4–6 found an unresolvable issue (server down, cert expired, extension blocked).

**Vendor VPNs (scoped):** if the target is a vendor client (Step 1 `installedClients`, no matching native profile) OR `reconnect_vpn` returns `vendorManaged`, it does NOT reconnect — surface the returned `message` verbatim (reconnect via the vendor client; expect a browser sign-in on SAML VPNs) and go to Step 10. Do NOT drive a vendor client through `reconnect_vpn`.

**Step 10 — Confirm reconnection (vendor / browser-auth path)**
`Condition:` only if Step 9 returned `vendorManaged`, OR a native reconnect did not settle (`reconnected === false` / `newStatus` still `"Connecting"`), OR the user was guided to reconnect manually. `wait_for_user_ack`: *"Reconnect via your VPN client (complete any browser sign-in), then tell me when you're back online."* options `{ reconnected, couldnt-connect }`. Bridges the window where a full-tunnel/SAML reconnect cuts the agent's own connection, or where a native tunnel needs the user to finish MFA. Skip for a clean native success (`reconnected === true`).

**Step 11 — Flush DNS**
Call `flush_dns_cache` (clears pre-tunnel DNS entries that make internal hostnames resolve to external IPs). `Condition:` only if a reconnect succeeded (Step 9 native success or Step 10 `"reconnected"`).

**Step 12 — Internal hostname**
`request_user_input` for a hostname/IP to ping — prompt: "An internal hostname or IP I can ping to verify the tunnel routes (intranet site, internal Jira, or a VPN-only server IP)?", placeholder `intranet.company.com or 10.0.0.5`, validator `^[\w.\-]+$`. `Condition:` only if a reconnect succeeded. Empty → skip Step 13, report "tunnel up; routing not verified".

**Step 13 — Verify routing**
`check_connectivity` with `targets: [<Step 12 value>]`. `inputsFrom: [{ step: 12, field: "value" }]`. `Condition:` only if Step 12 returned a non-empty `value`.

**Step 14 — Final report**
Summarise findings and fixes. Escalate: cert expired → IT renewal; extension blocked → IT (MDM policy); server unreachable → IT (server/firewall).

---

## Privilege handling

`flush_dns_cache` needs admin → the helper daemon runs it silently when available. `reconnect_vpn` is NOT helper-routed but fires through G4 consent. If the helper is unavailable or for any vendor VPN, guide self-service: **reconnect** — VPN menu-bar (macOS)/tray (Windows) icon → Disconnect, 5s, Connect; **DNS flush (Windows)** `ipconfig /flushdns` (no admin), macOS sleep/wake refreshes the resolver. Always package the Step 1–6 diagnosis for IT.

---

## Edge cases

- **Mode** — "cannot connect" = path/cert/extension (Steps 3–7); "connected but not working" = stale session/DNS/routing (Steps 9–13).
- **Split tunnel** — some VPNs route only corporate traffic. If internet works but an internal resource doesn't, confirm it's on a VPN-covered subnet first.
- **Multiple clients** — only one tunnel can be active; a connected native macOS VPN can block AnyConnect.
- **SAML/MFA** — GlobalProtect/Zscaler use browser auth; reconnect opens a browser (Step 10's ack covers it). A just-approved system extension may need a reboot to activate.
- **Port-blocked** — `check_connectivity` is ICMP only. If the server pings but the tunnel won't form, try `check_certificate_expiry` on the native port (handshake error expected on non-HTTPS ports like IKEv2/500), else escalate to IT for a firewall check.
