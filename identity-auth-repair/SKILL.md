---
name: identity-auth-repair
description: Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures. Use when multiple identity-dependent apps (Outlook, VPN, Teams, Slack, corporate web apps) fail simultaneously — the root cause is often a single issue like NTP drift, an expired Kerberos TGT, or an expired client certificate. Fixes the underlying cause so all the downstream apps start working again.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_ntp_status
  - sync_system_time
  - check_kerberos_ticket
  - renew_kerberos_ticket
  - list_client_certificates
  - check_certificate_expiry
  - check_ad_binding
  - check_connectivity
metadata:
  prerequisites:
    before-corrective:
      - check_ntp_status
      - check_kerberos_ticket
      - check_ad_binding
  maxAggregateRisk: medium
  userLabel: "Login or SSO keeps failing across multiple apps"
  examples:
    - "I can't log in to SSO"
    - "MFA codes keep being rejected"
    - "my VPN says authentication failed"
    - "Outlook and Teams and VPN are all broken at once"
    - "Kerberos error when opening a file share"
    - "Active Directory says my password is wrong on every app"
  pill:
    label: Fix Login/SSO
    goal: I'm getting authentication failures across multiple apps (VPN, email, SSO, file shares). Please diagnose the root cause and repair it.
    icon: ShieldCheck
    iconClass: text-emerald-500
    order: 11
  proactive-triggers:
    # Wave 2 Track B Phase 4 — Trigger 2 (highest-blast-radius prevention).
    # One expired cert on Friday night = 50+ Monday tickets.
    - name: certificate-expiring
      telemetry:
        tool: check_certificate_expiry
        intervalMs: 21600000     # 6 h — certificate expiry is days-out signal, slow polling
        params:
          host: "vpn.example.com"   # Per-tenant override via cloud-triggers customTriggers
      condition: "daysUntilExpiry <= 7 && isExpired == false"
      duration: immediate
      autofix: false
      severity: high
    # Wave 2 Track B Phase 4 — Trigger 6 (subtle cascade prevention).
    # 60s drift breaks Kerberos + SAML + TOTP simultaneously above the 5-min threshold.
    - name: ntp-drift
      telemetry:
        tool: check_ntp_status
        intervalMs: 1800000      # 30 min
      condition: "absOffsetMs > 60000"
      duration: 30m              # Sustained drift, not transient — hysteresis prevents flapping
      autofix: false
      severity: medium
---

## When to use

Use this skill when the user:
- Reports that **multiple** identity-dependent apps are failing auth at the same time (Outlook, VPN, Teams, Slack, corporate intranet, file shares)
- Gets "MFA code rejected" errors consistently
- Sees a Kerberos error message in any client (Outlook, file share, SSH)
- Mentions repeated auth failures after a known quiet period (laptop woke from sleep, travelled across time zones, came back from vacation)
- Cannot reach the Active Directory / LDAP / identity provider

Do NOT use this skill when:
- The user says they need to reset a cloud IDP password — use `cloud-idp-password-reset`.
- The user's local Mac / Windows password is not working — use `password-reset`.
- Only one app is failing and the rest work — use the app-specific skill (`email-repair`, `vpn-repair`, etc.).

The big win of this skill is catching **NTP drift** as the root cause. A clock skew > 5 minutes silently breaks Kerberos, SAML, and TOTP simultaneously — users see "VPN and email and MFA are all broken" but the real fix is a single NTP resync.

---

## Steps

**Step 1 — Check NTP drift (root cause #1)**
Call `check_ntp_status` (no parameters). The tool reports the endpoint's clock offset from a reference NTP source in milliseconds. An `absOffsetMs > 300000` (5 minutes) explains simultaneous Kerberos + SAML + TOTP failures — surface this to the user immediately as the likely root cause. If `status === "drifted"`, jump to Step 2 to fix it. If `status === "ok"` or `"error"`, continue to Step 3.

**Step 2 — Sync system time (if drifted)**
Call `sync_system_time` with `dryRun: true` first so the G4 dry-run gate shows the user the exact command. The command requires admin privileges. After user confirmation, call again with `dryRun: false`. If the tool returns `success: false` with a message about sudo / admin rights, surface the guidance verbatim — the user will need to run the command themselves in an elevated terminal. Then re-run `check_ntp_status` to confirm the drift is resolved.

**Step 3 — Check Kerberos tickets (root cause #2)**
Call `check_kerberos_ticket` with `expiryWarnMinutes: 60`. The tool lists active TGTs + service tickets and flags ones that are expired or expiring within the window.
- `status === "ok"` → Kerberos is healthy; skip to Step 5.
- `status === "expiring"` or `"expired"` → proceed to Step 4 to renew.
- `status === "missing"` → the user has no Kerberos credentials at all. On macOS this is normal if they aren't AD-bound; on Windows it suggests a logon problem. Check `check_ad_binding` to see whether the machine expects AD credentials; if it does, escalate to helpdesk because interactive re-authentication is required and the agent will not handle passwords.

**Step 4 — Renew Kerberos ticket (if expiring or expired)**
Call `renew_kerberos_ticket` with `dryRun: true`. The tool's G4 gate fires the dry-run preview (showing `kinit -R` on macOS, `klist purge && gpupdate /force` on Windows). After user confirmation, call `dryRun: false`.

**On Windows** with the privileged helper daemon installed (default), the `renew_kerberos_ticket` op runs through the helper as `LocalSystem` and completes silently for **all users — admin and non-admin alike**. AD reissues a fresh TGT on next access. No "this requires admin" messaging is needed.

**On macOS** the op is **not yet supported via the helper** in v1 fast-follow — Heimdal / MIT-KfM integration is deferred. The handler returns `helper-error` with `stderr: "Platform not supported"` on macOS; the user must renew interactively (`kinit <principal>` in Terminal). The agent will not handle the password.

Status outcomes:
- `status === "renewed"` → success; re-run `check_kerberos_ticket` to confirm a valid ticket is back in place.
- `status === "interactive"` → the ticket is not renewable (macOS path; or Windows when the helper is unavailable / disabled). Surface the tool's message verbatim — the user must open a terminal and run `kinit <principal>` themselves; the agent will **not** handle the password.
- `status === "failed"` → surface the tool's error message and continue to Step 5.

**Step 5 — Enumerate client certificates**
Call `list_client_certificates` with `expiryWarnDays: 30`. The tool reports every personal / machine client cert with its expiry status.
- `status === "ok"` or `"empty"` → certs are not the problem; continue to Step 6.
- `status === "expired"` or `"expiring"` → surface the specific subjects/thumbprints to the user. Client certs cannot be silently renewed — they must be re-issued by the user's MDM or certificate authority. Point the user to their IT team with the specific cert details so the renewal request is actionable. Continue to Step 6 to verify remaining components; do NOT end the run yet.

**Step 6 — Spot-check VPN / SSO certificate expiry**
If the user mentioned VPN or SSO-endpoint failures specifically, call `check_certificate_expiry` on the failing endpoint (ask the user for the hostname if you don't already know it). An expiring server cert on the far side looks identical to a local identity problem and is a common false positive — catching it here saves the user a pointless support round-trip.

**Step 7 — Verify AD / domain binding (Windows AD environments)**
If the user's machine is domain-joined, call `check_ad_binding`. A broken binding causes symptoms that mimic every other auth failure at once, and cannot be repaired locally — escalate to helpdesk with the specific binding error.

**Step 8 — Verify basic network reachability**
If all of the above look healthy but the user is still reporting failures, call `check_connectivity` to rule out network-layer issues (the endpoint can't reach the identity provider at all). An unreachable IdP looks indistinguishable from every other failure class.

**Step 9 — Summarise + guide the user**
Summarise what was found and what was fixed:
- NTP drift corrected → apps should start working within a few minutes as auth retries succeed.
- Kerberos TGT renewed → file shares + SSO should work immediately; VPN may need a reconnect.
- Expired client cert → user must request re-issue from IT; no silent fix possible.
- Broken AD binding → user must contact IT; this skill cannot rebind.
- Nothing obvious found → advise the user to restart their session (lock screen + sign in, or reboot if possible) so the OS re-acquires fresh credentials; if that fails, escalate via the end-of-run ticket.

---

## Edge cases

- **User travelled across time zones + laptop was asleep.** Wake-from-sleep + large time change is a classic NTP-drift trigger. Step 1 will catch it; Step 2 fixes it.
- **FileVault unlock uses a stale password.** Not this skill's territory — FileVault credentials are separate from cloud IDP and Kerberos credentials. If the user cannot even reach the login screen, direct them to their Recovery Key or IT.
- **MFA still fails after NTP fix.** TOTP codes depend on synced clocks. After Step 2, the user should wait ~30 seconds for a fresh code before retrying — an in-flight code was generated on the skewed clock and will still fail.
- **Kerberos ticket renewal succeeds but VPN still fails.** Some VPN clients hold a stale cached ticket. After Step 4 the user may need to disconnect + reconnect the VPN to pick up the fresh TGT.
- **Client cert expiring within 30 days.** Does not block auth TODAY but will in the near future. Still surface it to the user so they can schedule a renewal before it becomes an emergency.
- **Machine is Entra-joined (no traditional AD binding).** `check_ad_binding` will report "not domain-joined" — that's correct and expected on Entra-joined endpoints. Do NOT treat as a failure; proceed to the next step.
- **Hybrid AD + Entra with password writeback.** If the user just reset their cloud password and Kerberos still rejects, on-prem propagation can lag 15–30 min. Advise waiting before concluding Kerberos is broken.
- **Password is NOT collected by this skill.** All corrective tools avoid handling passwords: `renew_kerberos_ticket` uses `kinit -R` (no prompt) or surfaces "interactive" so the user runs `kinit` in their own terminal. The agent's security boundary is the same as in `cloud-idp-password-reset`.
