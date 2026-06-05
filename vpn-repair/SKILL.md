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

Use this skill when the user:
- Cannot connect to VPN or the connection drops immediately
- Reports VPN shows "Connected" but internal resources are unreachable
- Gets certificate errors or authentication failures when connecting
- Reports VPN was working but stopped after a macOS/Windows update
- Asks "why won't my VPN connect?" or "my VPN is connected but nothing works"

Do NOT use this skill if the user has no internet connectivity at all — use the `network-reset` skill first to restore basic connectivity, then retry VPN.

---

## Steps

**Step 1 — Check current VPN status**
Call `check_vpn_status` to identify all active VPN interfaces, their connection state, assigned IP addresses, and which VPN clients are installed. This establishes whether the VPN is connected, disconnected, or stuck in a partial state.

**Step 2 — List configured profiles**
Call `get_vpn_profiles` to enumerate all configured VPN profiles. Identify which profile the user is trying to use and confirm it is still present and has the correct server address.

**Step 3 — Check general connectivity first**
Call `check_connectivity` with default targets (8.8.8.8, 1.1.1.1, google.com) to confirm the device has internet access. If the device cannot reach the internet at all, VPN cannot connect — switch to the `network-reset` skill.

**Step 4 — Check VPN server connectivity**
Test connectivity to the VPN server hostname directly. Call `check_connectivity` with the VPN server hostname as a target. A failure here indicates a network path issue to the VPN server specifically.

`Condition:` only run if Step 3's `check_connectivity` showed general internet is reachable AND Step 1's `check_vpn_status` showed the VPN is NOT connected. Skip if the VPN is already connected (Step 7's reconnect path handles "connected but not routing") or if general internet is down (the user has bigger problems — escalate to `network-reset`).

**Step 5 — Check certificate expiry**
Call `check_certificate_expiry` on the VPN server hostname (port 443 or 8443 depending on the VPN type). An expired server certificate causes TLS handshake failures that appear as generic "cannot connect" errors. Also check if the VPN uses client certificates — if so, the client cert may have expired separately (this cannot be checked automatically; ask the user if they received a certificate renewal notice).

**Step 6 — Check network extension**
Call `check_network_extension` to verify the VPN client's system extension is loaded and approved. The tool accepts an optional `extensionName: string` parameter — it is a **substring filter** on the system extension names (NOT a bundle-ID lookup like `check_system_extension`). Usage:
- Call with no parameter to list every network extension on the device (useful for the initial survey).
- Call with `extensionName: "cisco"`, `extensionName: "paloaltonetworks"`, `extensionName: "anyconnect"`, or similar substring to target one vendor's extension when you already know which VPN client the user is trying to use (from Step 1's `check_vpn_status` output).

On macOS, VPN clients (AnyConnect, GlobalProtect, etc.) require a user-approved network extension. If any extension shows "waiting for user" or is not activated, Step 7's `wait_for_user_ack` will surface that to the user and wait for them to approve it in System Settings before continuing. On Windows, the tool falls back to inspecting VPN/TAP network adapters — the approval-flow gate (Step 7) skips on non-darwin platforms.

**Step 7 — Wait for user to approve network extension (macOS only)**
Approving a system extension in System Settings → Privacy & Security is out-of-band — the agent cannot observe the click. Call `wait_for_user_ack` to pause until the user confirms approval (or reports they couldn't):

```yaml
prompt: "Your VPN client's network extension needs approval in System Settings before the VPN can function. Open System Settings → Privacy & Security, find {extensionName} in the list, and click Allow. Let me know when you've done it."
options:
  - { id: "approved",  label: "I approved it",            kind: "primary" }
  - { id: "blocked",   label: "It's blocked by MDM",      kind: "secondary" }
  - { id: "not-there", label: "I don't see the extension", kind: "secondary" }
```

`Condition:` only run if (a) Step 6's `check_network_extension` returned at least one extension with `status === "waiting-for-user"` (or vendor-equivalent string indicating pending approval), AND (b) platform is `darwin`. Skip silently on Windows and when no extensions need approval. On `choice === "blocked"`, end the run with IT-escalation advice (MDM policy needed); on `choice === "not-there"`, end the run with VPN-client-reinstall advice (see software-reinstall skill). Only proceed to Step 8 on `choice === "approved"`.

Substitute `{extensionName}` in the prompt with the first pending-approval extension's display name from Step 6's output.

**Step 8 — Pick VPN profile (if multiple configured)**
If Step 2's `get_vpn_profiles` returned more than one profile, the user must choose which one to reconnect. Call `wait_for_user_ack` with one option per profile (clamped to the top 4 by most-recently-used, or alphabetical if no MRU signal):

```yaml
prompt: "You have multiple VPN profiles configured. Which one are you trying to use?"
options:
  - { id: "{profile-1-name}", label: "{profile-1-name}", kind: "primary" }
  - { id: "{profile-2-name}", label: "{profile-2-name}", kind: "secondary" }
  # … up to 4 total. If real count > 4, the 4th option becomes:
  - { id: "other", label: "Other (tell me in chat)", kind: "secondary" }
```

`inputsFrom: [{ step: 2, field: "profiles" }]` — iterate `profiles[].name` to populate the options.

`Condition:` only run if Step 2's `get_vpn_profiles` returned `profiles.length > 1`. Skip if there's only one profile (use it directly in Step 9) or zero profiles (escalate to IT — no profiles configured). On `choice === "other"`, fall back to `request_user_input` with `prompt: "Type the exact profile name"` before proceeding.

**Step 9 — Reconnect VPN**
Call `reconnect_vpn` to force a clean disconnect/reconnect cycle. The G4 consent gate fires automatically (`tool.meta.requiresConsent: true`) and surfaces the dry-run preview (`tool.meta.supportsDryRun: true`) inside the consent card so the user sees which profile would be reconnected before approving. On approval, the corrective call runs.

`inputsFrom:`
- If Step 8 ran: `[{ step: 8, field: "choice" }]` — pass `profileName` set to the user-picked profile id.
- Else: `[{ step: 2, field: "profiles" }]` — pass `profileName` set to the single profile's `name`.

Fallback source if Step 2 returned no profiles: Step 1's `check_vpn_status.clientConnections[].name`.

`Condition:` only run if (a) Step 1's `check_vpn_status` shows the VPN is connected but routing is broken (a Step 12 internal-hostname check would fail), OR (b) Steps 4–6 surfaced a fixable issue (server reachable, cert valid, extension approved — and Step 7's ack returned `"approved"` if it ran) and a reconnect is the natural corrective. Skip if Steps 4–6 surfaced an unresolvable issue (server down, cert expired, extension blocked) — escalate to IT instead.

Surface the MFA/SAML warning (see Edge Cases) in the rationale before the consent gate fires — a reconnect on those VPNs triggers a browser auth window the user needs to anticipate.

If `reconnect_vpn` returns `vendorManaged` (a Cisco AnyConnect / Palo Alto GlobalProtect profile — scutil cannot drive these), it does NOT reconnect: surface the returned `message` verbatim (reconnect via the vendor client) and treat the step as "guidance given," not a failure. Step 10's DNS flush will skip because the reconnect did not succeed; proceed to verification.

**Step 10 — Flush DNS after reconnect**
Call `flush_dns_cache` to clear any stale DNS entries from before the VPN tunnel was established. DNS entries cached before VPN connect often point to external IPs instead of internal ones, making internal hostnames unreachable even when the tunnel is up.

`Condition:` only run if Step 9's `reconnect_vpn` ran AND returned success. Skip if Step 9 was skipped (no reconnect happened, so cache state is unchanged) or if Step 9 failed (no tunnel to flush DNS for).

**Step 11 — Capture an internal hostname for verification**
Step 12 needs an internal hostname or IP to ping in order to verify the VPN tunnel is routing correctly. The user is the only source for this — internal hostnames are organization-specific and not in scratchpad. Call `request_user_input`:

```yaml
prompt: "What's an internal hostname or IP I can ping to verify the VPN tunnel is routing? Something like an intranet site, an internal Jira/Confluence URL, or a server IP only reachable through the VPN."
placeholder: "intranet.company.com or 10.0.0.5"
validator: "^[\\w.\\-]+$"
```

`Condition:` only run if Step 9 ran (this is the verification setup for the reconnect). Skip if Step 9 was skipped — there's nothing new to verify.

If the user submits an empty value (timeout / cancel), skip Step 12 and go straight to Step 13's final report with "tunnel-up status verified; routing not verified because user did not provide an internal hostname".

**Step 12 — Verify tunnel routing**
Call `check_connectivity` with `targets: [<hostname from Step 11>]`. A successful ping to an internal resource confirms the tunnel is routing correctly.

`inputsFrom: [{ step: 11, field: "value" }]`

`Condition:` only run if Step 11 returned a non-empty `value`. Skip otherwise.

**Step 13 — Final report**
Summarise what was found and what was fixed. If the issue persists after all steps, escalate recommendations:
- If certificate expired: advise the user to contact IT for a certificate renewal
- If network extension blocked: escalate to IT as MDM may need to push an approval policy
- If VPN server unreachable: escalate to IT as the server or firewall may be down

---

## Privilege handling — helper-routed (default) vs. fallback

Step 10 (`flush_dns_cache`) requires admin to execute the underlying OS command. Step 9 (`reconnect_vpn`) requires admin only on certain VPN clients that need to manipulate the network extension; some clients accept user-initiated disconnect/reconnect from the menu-bar UI without elevation.

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): `flush_dns_cache` routes through the helper and completes silently for **all users — admin and non-admin alike**. `reconnect_vpn` is NOT in the helper allowlist (VPN clients vary too much to handle uniformly); it still depends on the underlying client's design, but it does fire through the G4 consent gate (`tool.meta.requiresConsent: true`) so the user explicitly approves the reconnect before it runs.

**When the helper is unavailable for `flush_dns_cache`** (`denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`) or for `reconnect_vpn`:

1. **Self-service for `reconnect_vpn` is unusually clean** — every enterprise VPN client (Cisco AnyConnect, GlobalProtect, Pulse Secure, NetSkope, Zscaler, Microsoft VPN) has a **Disconnect** / **Connect** toggle in its menu-bar (macOS) or system-tray (Windows) icon that works without admin. Tell the user: *"Click your VPN client's icon in the menu bar (top-right on macOS) or system tray (bottom-right on Windows), choose Disconnect, wait 5 seconds, then choose Connect. This is the same operation the agent's `reconnect_vpn` performs internally."* For most "connected but no traffic" cases this resolves the issue.
2. **Self-service for DNS flush** (only relevant when helper is unavailable):
   - **macOS:** no clean self-service path; sleeping the laptop and waking it often refreshes the DNS resolver.
   - **Windows:** the user can run `ipconfig /flushdns` from a regular Command Prompt without admin (Windows DNS cache is per-user-accessible).
3. **For "VPN won't connect at all" tickets** that aren't fixed by the menu-bar toggle: the diagnostic packet from Steps 1–6 (VPN status, profiles, server reachability, certificate expiry, network extension state) is enough for tier-1 IT to pick up immediately without re-running the diagnosis.
4. **Always package the diagnostic for IT escalation** — the end-of-run ticket includes everything captured above so the user does not have to re-collect it. IT can also investigate why the helper is unavailable on this device when `helper-unavailable` denies surface.

---

## Edge cases

- **"Connected but not working" vs "cannot connect"** — these are different failure modes. "Cannot connect" is usually a network path, certificate, or extension issue (Steps 3–6). "Connected but not working" is usually a stale session, DNS, or routing issue (Steps 7–9)
- **Split tunnelling** — some VPN configurations only route corporate traffic through the tunnel; internet traffic goes direct. If the user can reach the internet but not an internal resource, ask if the resource is on a subnet covered by the VPN policy before assuming the VPN is broken
- **Multiple VPN clients** — if both AnyConnect and a built-in VPN profile are present, only one can be active at a time. If a built-in macOS VPN is connected, it may block AnyConnect from establishing its own tunnel
- **MFA / SAML authentication** — some VPNs (GlobalProtect, Zscaler) use browser-based SAML auth. A reconnect attempt opens a browser window for the user to authenticate — warn the user to expect this before calling `reconnect_vpn`
- **Network extension requires reboot** — if a system extension was just approved in Security Settings, macOS may require a reboot before the extension activates. If `check_network_extension` shows the extension was just approved, advise the user to reboot before retrying
- **Corporate firewall blocking VPN ports** — some networks (hotels, coffee shops) block IKEv2 (UDP 500/4500) or L2TP ports. **Note**: `check_connectivity` uses ICMP ping only and cannot test specific UDP or TCP ports — it can only answer "is the host reachable at the IP layer?". To diagnose port-level blocking with the currently available tools, the closest substitute is `check_certificate_expiry` on a specific TCP port (e.g. 443 for SSL VPN, 8443 for alternate HTTPS, 500 for IKEv2 — though 500 will not be HTTPS so expect a TLS handshake failure, not a certificate result). If `check_connectivity` reports the VPN server reachable (ICMP) but the VPN client still cannot establish a tunnel, and `check_certificate_expiry` succeeds on port 443 but fails on the VPN's native port, advise the user to switch to an SSL-based VPN profile if one is available. Alternatively, escalate to IT for a firewall-level diagnosis — reliable UDP-port reachability testing is outside the scope of this skill
