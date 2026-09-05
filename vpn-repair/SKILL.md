---
name: vpn-repair
description: Diagnoses and repairs VPN connectivity issues including stale connections, misconfigured profiles, expired certificates, missing network extensions, and DNS leaks. Use when user cannot connect to VPN or VPN appears connected but traffic is not routing.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - survey_vpn
  - check_connectivity
  - check_network_extension
  - reconnect_vpn
  - flush_dns_cache
  - c_mdm_diagnose_configuration
  - c_mdm_reapply_configuration
  - wait_for_user_ack
  - request_user_input
metadata:
  prerequisites:
    before-corrective:
      - survey_vpn
      - check_connectivity
      - check_network_extension
  # Raised from medium when the MDM branch landed: c_mdm_reapply_configuration
  # is riskLevel high, and G2 blocks the whole plan when any step exceeds this
  # ceiling. The local correctives remain medium; the high step is the MDM
  # re-apply, which is consent-gated and non-destructive.
  maxAggregateRisk: high
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

**Step 1 — Survey the VPN**
Call `survey_vpn`. One call returns connection state and every configured profile. Read:
- `isConnected` / `activeConnections` — whether a tunnel is up. Connected but internal resources unreachable is the routing case, not the connection case.
- `nativeProfiles` / `nativeProfileCount` — the profiles `reconnect_vpn` can actually drive. Use `nativeProfiles` for the profile name in Step 6; do NOT read `profiles` for that, which includes vendor-managed entries the tool cannot drive.
- `vendorPresent` — a vendor client is installed or a vendor-managed profile exists. `reconnect_vpn` returns `vendorManaged` for these and hands off to the vendor app; do not try to drive one.
- **`nativeProfileCount: 0` AND `vendorPresent: false`** — nothing is configured on this machine at all, so there is nothing to reconnect: do NOT attempt it. On a **managed** device this means a VPN configuration profile was never delivered — a different fault from "the VPN will not connect" — and the MDM arm is where to look. On an unmanaged device there is no profile to deliver and no MDM to ask: report that no VPN is configured, point the user at IT to have one provisioned, and stop.

**Step 2 — Base internet**
`check_connectivity` (8.8.8.8, 1.1.1.1, google.com). No internet at all → VPN can't connect; switch to `network-reset`.

**Step 3 — VPN server reachability**
`check_connectivity` with the VPN server hostname as target. `Condition:` only if Step 2 showed internet up AND Step 1 showed VPN NOT connected. Skip if already connected (Step 7 handles "connected but not routing") or internet is down.

**Step 4 — Network extensions (survey all)**
`check_network_extension` with **no argument** — lists every VPN/security extension (system + app). Do NOT pass a vendor name; the survey returns all and Step 5 inspects them. Entries have `name`/`identifier`/`state`/`type`; result also carries `allActivated`.

**Step 5 — Approve extension (macOS only)**
Approval is out-of-band, so gate on it. `wait_for_user_ack`:

```yaml
prompt: "Your VPN client's network extension '{name}' needs approval. Open System Settings → Privacy & Security, find it, and click Allow. Tell me when done."
options:
  - { id: "approved",  label: "I approved it",             kind: "primary" }
  - { id: "blocked",   label: "It's blocked by MDM",       kind: "secondary" }
  - { id: "not-there", label: "I don't see the extension", kind: "secondary" }
```

`Condition:` only on `darwin` AND Step 4 shows a pending extension — `allActivated === false` AND some `extensions[].state` includes `"waiting for user"`. Substitute `{name}` from that extension. On `"blocked"` → IT (MDM policy); `"not-there"` → VPN-client reinstall (software-reinstall skill); proceed only on `"approved"`.

**Step 6 — Pick native profile (if multiple)**
`Condition:` only if Step 1 returned `nativeProfileCount` greater than 1. `wait_for_user_ack`, one option per entry in `nativeProfiles` (top 4 by MRU else alphabetical; 4th = "Other (tell me in chat)" if more). `inputsFrom: [{ step: 1, field: "nativeProfiles" }]`. `"other"` → `request_user_input` for the exact name. Exactly one → use it directly; zero → Step 7's vendor path.

**Step 7 — Reconnect**
Call `reconnect_vpn` with `profileName` — `inputsFrom`: Step 6 if it ran (`{ step: 6, field: "choice" }`), else the single entry in Step 1’s `nativeProfiles` (`{ step: 1, field: "nativeProfiles" }`); fallback when that is empty, Step 1’s `activeConnections[].name`. Pass ONLY `profileName` — do **NOT** author a `dryRun` param; G4 owns the dry-run preview + consent gates and an injected `dryRun: true` would silently no-op the reconnect. **Warn in the rationale:** *"if your VPN carries all traffic, you may briefly lose contact with me while it reconnects — I'll resume once you're back."*

The tool waits for the tunnel to settle, so trust its result. `reconnected: true` is a real success → continue to Step 9.

On `reconnected: false` do NOT run Steps 9–11, and branch on `failureReason` — the tool reports why, so do not probe for it:
- `auth` — credentials, MFA or the account itself. Not repairable here; escalate with the detail.
- `unreachable` — the server or the path to it. Escalate to IT (server or firewall).
- `certificate` — go to Step 12's MDM arm; this is the one cause a re-apply can fix.
- `extension-not-approved` — the system extension is still pending. The plan runs forward only, so do NOT re-enter the earlier approval gate: report it as the finding and guide the user to System Settings → Privacy & Security → Allow, then to retry the skill once approved.
- `no-configuration` — the profile is missing or unusable; on a managed device that is Step 12's arm, otherwise IT.
- `timeout` — still negotiating at the deadline. Go to Step 8: it is usually waiting on the user to finish a sign-in or MFA.
- `unknown` — surface `failureDetail` and `message` verbatim and escalate. The OS did not say, so do not guess.

`Condition:` (a) Step 1 `isConnected === true` with an `activeConnections[]` entry `status` `"Connected"`/`"Active"` and the symptom is "connected but resources unreachable", OR (b) Steps 3–4 surfaced a fixable issue (server reachable, extension approved). Skip and escalate to IT if Steps 3–4 found an unresolvable issue (server down, extension blocked).

**Vendor VPNs (scoped):** if the target is a vendor client (Step 1 `vendorPresent: true` with `nativeProfileCount: 0`) OR `reconnect_vpn` returns `vendorManaged`, it does NOT reconnect — surface the returned `message` verbatim (reconnect via the vendor client; expect a browser sign-in on SAML VPNs) and go to Step 8. Do NOT drive a vendor client through `reconnect_vpn`.

**Step 8 — Confirm reconnection (vendor / browser-auth path)**
`Condition:` only if Step 7 returned `vendorManaged`, OR a native reconnect did not settle (`reconnected === false` / `newStatus` still `"Connecting"`), OR the user was guided to reconnect manually. `wait_for_user_ack`: *"Reconnect via your VPN client (complete any browser sign-in), then tell me when you're back online."* options `{ reconnected, couldnt-connect }`. Bridges the window where a full-tunnel/SAML reconnect cuts the agent's own connection, or where a native tunnel needs the user to finish MFA. Skip for a clean native success (`reconnected === true`).

**Step 9 — Flush DNS**
Call `flush_dns_cache` (clears pre-tunnel DNS entries that make internal hostnames resolve to external IPs). `Condition:` only if a reconnect succeeded (Step 7 native success or Step 8 `"reconnected"`).

**Step 10 — Internal hostname**
`request_user_input` for a hostname/IP to ping — prompt: "An internal hostname or IP I can ping to verify the tunnel routes (intranet site, internal Jira, or a VPN-only server IP)?", placeholder `intranet.company.com or 10.0.0.5`, validator `^[\w.\-]+$`. `Condition:` only if a reconnect succeeded. Empty → skip Step 11, report "tunnel up; routing not verified".

**Step 11 — Verify routing**
`check_connectivity` with `targets: [<Step 10 value>]`. `inputsFrom: [{ step: 10, field: "value" }]`. `Condition:` only if Step 10 returned a non-empty `value`.

**Step 12 — Stale client certificate? Check the device's MDM configuration**
`Condition:` only run if Step 7 returned `failureReason: "certificate"` or `"no-configuration"`.

This used to be a hypothesis inferred from what other probes did *not* find — server up, cert probe inconclusive, so perhaps the client certificate. The reconnect now reports the cause directly, so this arm runs only when the OS actually named a certificate or configuration fault. When `failureReason` is `unknown`, do NOT enter this arm on suspicion: report the detail and escalate.

Call `c_mdm_diagnose_configuration`. It reads enrollment, locates the device in the tenant, and returns the per-item states in one call. Every eligibility rule — reachable provider, readable serial, exactly one matching device, checked in within 7 days, at least one item in `failed` — is enforced inside the tool, so do not re-derive them here.

Only `outcome: "failed-items"` continues. On anything else, skip Steps 13–14 and escalate with the tool's `message` — it is already written for the user. On `stale-checkin` lead with the check-in age: a device that fell off management is more useful to IT than any symptom.

On `failed-items`, make the judgement the tool deliberately does not: **look through `items` for a SCEP / PKCS / certificate profile.**
- None present at all → this device does not get its client certificate from MDM. Stop and escalate with that finding. This is a real answer, not a failure.
- Present but absent from `failedItems` → it applied cleanly, so the expiry has another cause. Escalate rather than re-applying.
- Present in `failedItems` → name it; that is the likely cause. Quote its `stateReason` when set — it says *why* the profile failed.

**Step 13 — Re-apply the device's configuration**
`Condition:` only run if Step 12 found an assigned certificate profile that failed to apply. Call `c_mdm_reapply_configuration`. State plainly in the rationale that this tells the device to check in and re-apply **all** its assigned configuration, that it cannot issue a certificate IT has never authored a profile for, and that re-issuance completes asynchronously after the tool returns.

**Step 14 — Wait for the certificate to be re-issued**
`Condition:` only run if Step 13 returned `status: "ok"`. That proves only that the MDM accepted the request — it is not evidence a certificate was issued. Call `wait_for_user_ack`:

```yaml
prompt: "I've asked Intune to re-send your device's configuration, which should re-issue the VPN certificate. That usually takes a minute or two. Tell me when to retry the connection."
options:
  - { id: "ready", label: "Ready — retry now", kind: "primary" }
  - { id: "skip",  label: "Skip the retry",    kind: "cancel" }
```

**Step 15 — Retry the connection**
`Condition:` only run if Step 14 returned `ready`. Call `reconnect_vpn` again and trust its settled result exactly as Step 7 does: `reconnected === true` AND `newStatus === "Connected"` is a real success. Anything else means the re-sync did not resolve it — escalate with the certificate profile named in Step 12. Never report the VPN as fixed on the strength of Step 13 alone; on `skip` at Step 14, report the sync as initiated and unverified.

**Step 16 — Final report**
Summarise findings and fixes. Escalate: extension blocked → IT (MDM policy); server unreachable → IT (server/firewall); certificate profile missing or still failing after re-sync → IT.

---

## Privilege handling

`flush_dns_cache` needs admin → the helper daemon runs it silently when available. `reconnect_vpn` is NOT helper-routed but fires through G4 consent. If the helper is unavailable or for any vendor VPN, guide self-service: **reconnect** — VPN menu-bar (macOS)/tray (Windows) icon → Disconnect, 5s, Connect; **DNS flush (Windows)** `ipconfig /flushdns` (no admin), macOS sleep/wake refreshes the resolver. Always package the Step 1–4 diagnosis for IT.

---

## Edge cases

- **Mode** — "cannot connect" = path/extension (Steps 2–5); "connected but not working" = stale session/DNS/routing (Steps 7–11).
- **Split tunnel** — some VPNs route only corporate traffic. If internet works but an internal resource doesn't, confirm it's on a VPN-covered subnet first.
- **Multiple clients** — only one tunnel can be active; a connected native macOS VPN can block AnyConnect.
- **SAML/MFA** — GlobalProtect/Zscaler use browser auth; reconnect opens a browser (Step 8's ack covers it). A just-approved system extension may need a reboot to activate.
- **Port-blocked** — `check_connectivity` is ICMP only. If the server pings but the tunnel will not form, escalate to IT for a firewall check on the VPN port.
