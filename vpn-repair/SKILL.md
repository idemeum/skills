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
    order: 9
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
If internet is available but VPN fails to connect, test connectivity to the VPN server hostname directly. Call `check_connectivity` with the VPN server hostname as a target. A failure here indicates a network path issue to the VPN server specifically.

**Step 5 — Check certificate expiry**
Call `check_certificate_expiry` on the VPN server hostname (port 443 or 8443 depending on the VPN type). An expired server certificate causes TLS handshake failures that appear as generic "cannot connect" errors. Also check if the VPN uses client certificates — if so, the client cert may have expired separately (this cannot be checked automatically; ask the user if they received a certificate renewal notice).

**Step 6 — Check network extension**
Call `check_network_extension` to verify the VPN client's system extension is loaded and approved. The tool accepts an optional `extensionName: string` parameter — it is a **substring filter** on the system extension names (NOT a bundle-ID lookup like `check_system_extension`). Usage:
- Call with no parameter to list every network extension on the device (useful for the initial survey).
- Call with `extensionName: "cisco"`, `extensionName: "paloaltonetworks"`, `extensionName: "anyconnect"`, or similar substring to target one vendor's extension when you already know which VPN client the user is trying to use (from Step 1's `check_vpn_status` output).

On macOS, VPN clients (AnyConnect, GlobalProtect, etc.) require a user-approved network extension. If any extension shows "waiting for user" or is not activated, guide the user to System Settings → Privacy & Security and approve the listed extension. The VPN cannot function without this. On Windows, the tool falls back to inspecting VPN/TAP network adapters — the approval-flow guidance above doesn't apply.

**Step 7 — Reconnect VPN**
If the VPN shows as connected but traffic is not routing (a "split tunnel" or stale session issue), call `reconnect_vpn` to force a clean disconnect/reconnect cycle. Required parameters:
- `profileName` (required) — the VPN profile to reconnect. Source it from Step 2's `get_vpn_profiles` output (the `name` field of each profile) or from Step 1's `check_vpn_status` output (the `clientConnections[].name` field). If multiple profiles are configured, ask the user which one they're trying to use.
- `dryRun` (optional, **defaults to `true`**) — first call without specifying (or with `dryRun: true`) returns a preview of which profile would be reconnected. After user confirmation, call again with `dryRun: false` to actually perform the disconnect + 2-second pause + reconnect sequence. The G4 auto-gate on high-risk destructive actions does not fire here (`riskLevel: medium`, `destructive: false`), so the dry-run → confirm → run pattern in this step MUST be driven explicitly by the workflow.

For MFA/SAML VPNs (GlobalProtect, Zscaler) — see Edge Cases; a reconnect will trigger a browser auth window.

**Step 8 — Flush DNS after reconnect**
After a successful reconnect, call `flush_dns_cache` to clear any stale DNS entries from before the VPN tunnel was established. DNS entries cached before VPN connect often point to external IPs instead of internal ones, making internal hostnames unreachable even when the tunnel is up.

**Step 9 — Verify tunnel routing**
After reconnect and DNS flush, call `check_connectivity` again — this time targeting an internal hostname or IP (ask the user for one). A successful ping to an internal resource confirms the tunnel is routing correctly.

**Step 10 — Final report**
Summarise what was found and what was fixed. If the issue persists after all steps, escalate recommendations:
- If certificate expired: advise the user to contact IT for a certificate renewal
- If network extension blocked: escalate to IT as MDM may need to push an approval policy
- If VPN server unreachable: escalate to IT as the server or firewall may be down

---

## Graceful degradation when corrective steps deny

Steps 7 (`reconnect_vpn`) and 8 (`flush_dns_cache`) require administrator privileges. For non-admin users the G4 scope check returns `outcome: "denied"` and the corrective step does not run — but this does **not** abort the workflow. Continue diagnostic steps; the diagnosis itself is the deliverable.

When a corrective step denies due to insufficient privileges:

1. **Self-service for `reconnect_vpn` is unusually clean** — every enterprise VPN client (Cisco AnyConnect, GlobalProtect, Pulse Secure, NetSkope, Zscaler, Microsoft VPN) has a **Disconnect** / **Connect** toggle in its menu-bar (macOS) or system-tray (Windows) icon that works without admin. Tell the user: *"Click your VPN client's icon in the menu bar (top-right on macOS) or system tray (bottom-right on Windows), choose Disconnect, wait 5 seconds, then choose Connect. This is the same operation the agent's `reconnect_vpn` performs internally."* For most "connected but no traffic" cases this resolves the issue.
2. **Self-service for DNS flush is harder.**
   - **macOS:** no clean self-service path; sleeping the laptop and waking it often refreshes the DNS resolver.
   - **Windows:** the user can run `ipconfig /flushdns` from a regular Command Prompt without admin (Windows DNS cache is per-user-accessible).
3. **For "VPN won't connect at all" tickets** that aren't fixed by the menu-bar toggle: the diagnostic packet from Steps 1–6 (VPN status, profiles, server reachability, certificate expiry, network extension state) is enough for tier-1 IT to pick up immediately without re-running the diagnosis.
4. **Always package the diagnostic for IT escalation** — the end-of-run ticket includes everything captured above so the user does not have to re-collect it.

---

## Edge cases

- **"Connected but not working" vs "cannot connect"** — these are different failure modes. "Cannot connect" is usually a network path, certificate, or extension issue (Steps 3–6). "Connected but not working" is usually a stale session, DNS, or routing issue (Steps 7–9)
- **Split tunnelling** — some VPN configurations only route corporate traffic through the tunnel; internet traffic goes direct. If the user can reach the internet but not an internal resource, ask if the resource is on a subnet covered by the VPN policy before assuming the VPN is broken
- **Multiple VPN clients** — if both AnyConnect and a built-in VPN profile are present, only one can be active at a time. If a built-in macOS VPN is connected, it may block AnyConnect from establishing its own tunnel
- **MFA / SAML authentication** — some VPNs (GlobalProtect, Zscaler) use browser-based SAML auth. A reconnect attempt opens a browser window for the user to authenticate — warn the user to expect this before calling `reconnect_vpn`
- **Network extension requires reboot** — if a system extension was just approved in Security Settings, macOS may require a reboot before the extension activates. If `check_network_extension` shows the extension was just approved, advise the user to reboot before retrying
- **Corporate firewall blocking VPN ports** — some networks (hotels, coffee shops) block IKEv2 (UDP 500/4500) or L2TP ports. **Note**: `check_connectivity` uses ICMP ping only and cannot test specific UDP or TCP ports — it can only answer "is the host reachable at the IP layer?". To diagnose port-level blocking with the currently available tools, the closest substitute is `check_certificate_expiry` on a specific TCP port (e.g. 443 for SSL VPN, 8443 for alternate HTTPS, 500 for IKEv2 — though 500 will not be HTTPS so expect a TLS handshake failure, not a certificate result). If `check_connectivity` reports the VPN server reachable (ICMP) but the VPN client still cannot establish a tunnel, and `check_certificate_expiry` succeeds on port 443 but fails on the VPN's native port, advise the user to switch to an SSL-based VPN profile if one is available. Alternatively, escalate to IT for a firewall-level diagnosis — reliable UDP-port reachability testing is outside the scope of this skill
