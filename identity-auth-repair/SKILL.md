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
  - wait_for_user_ack
  - request_user_input
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
    order: 10
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
- The user's local Mac / Windows password is not working — this skill cannot help (the user cannot run the agent if they cannot log in to their machine). Direct them to IT helpdesk for an in-person / phone-based local password reset.
- Only one app is failing and the rest work — use the app-specific skill (`email-repair`, `vpn-repair`, etc.).

The big win of this skill is catching **NTP drift** as the root cause. A clock skew > 5 minutes silently breaks Kerberos, SAML, and TOTP simultaneously — users see "VPN and email and MFA are all broken" but the real fix is a single NTP resync.

---

## Steps

**Step 1 — Check NTP drift (root cause #1)**
Call `check_ntp_status` (no parameters). The tool reports the endpoint's clock offset from a reference NTP source in milliseconds. An `absOffsetMs > 300000` (5 minutes) explains simultaneous Kerberos + SAML + TOTP failures — surface this to the user immediately as the likely root cause.

**Step 2 — Sync system time (if drifted)**
Call `sync_system_time`. G4 fires the consent gate automatically (`tool.meta.requiresConsent: true`) with the dry-run preview inside (`tool.meta.supportsDryRun: true`) so the user sees the exact command before approving. The op needs admin and routes through the privileged helper daemon when available.

`Condition:` only run if Step 1's `check_ntp_status` returned `status === "drifted"`. Skip silently for `"ok"` or `"error"`.

If the tool returns `success: false` with a sudo/admin-required message (helper unavailable on this device, or non-admin fallback), surface the guidance verbatim — the user must run the command themselves in an elevated terminal. Step 3 will then ack that work.

**Step 3 — Wait for user to complete sudo time-sync (helper-unavailable fallback)**
Call `wait_for_user_ack` to pause until the user finishes running the sudo command:

```yaml
prompt: "I couldn't run the time-sync command automatically — admin rights aren't available through the helper. Open a Terminal, run the command I just showed you with sudo, and let me know when it's done."
options:
  - { id: "done",    label: "I ran the command",       kind: "primary" }
  - { id: "failed",  label: "Couldn't run / failed",   kind: "secondary" }
  - { id: "skip",    label: "Skip — leave clock as-is", kind: "cancel" }
```

`Condition:` only run if Step 2 ran AND returned a needs-sudo error (i.e. helper-unavailable / scope-boundary deny on the sync_system_time call). Skip silently if Step 2 was skipped, succeeded silently via the helper, or wasn't needed at all.

On `done`: re-run `check_ntp_status` (re-fire Step 1) to confirm the drift is resolved before continuing. Without this gate, the re-check fires while the user is still typing their sudo password.

**Step 4 — Check Kerberos tickets (root cause #2)**
Call `check_kerberos_ticket` with `expiryWarnMinutes: 60`. The tool lists active TGTs + service tickets and flags ones that are expired or expiring within the window.
- `status === "ok"` → Kerberos is healthy; skip to Step 7.
- `status === "expiring"` or `"expired"` → proceed to Step 5 to renew.
- `status === "missing"` → the user has no Kerberos credentials at all. On macOS this is normal if they aren't AD-bound; on Windows it suggests a logon problem. Step 10's `check_ad_binding` will clarify whether the machine expects AD credentials; if it does, escalate to helpdesk because interactive re-authentication is required and the agent will not handle passwords.

**Step 5 — Renew Kerberos ticket (if expiring or expired)**
Call `renew_kerberos_ticket`. G4 fires the consent gate automatically (`tool.meta.requiresConsent: true`) with the dry-run preview inside (`tool.meta.supportsDryRun: true`) — the preview shows `kinit -R` on macOS, `klist purge && gpupdate /force` on Windows.

`Condition:` only run if Step 4's `check_kerberos_ticket` returned `status === "expiring"` OR `"expired"`. Skip for `"ok"` (nothing to renew) and `"missing"` (no ticket to renew from — Step 10's AD check handles that case).

**On Windows** with the privileged helper daemon installed (default), the op runs through the helper as `LocalSystem` and completes silently for **all users — admin and non-admin alike**. AD reissues a fresh TGT on next access.

**On macOS** the op is **not yet supported via the helper** in v1 fast-follow — Heimdal / MIT-KfM integration is deferred. The handler returns `helper-error` with `stderr: "Platform not supported"` on macOS; Step 6 will ack the user's interactive `kinit`.

Status outcomes:
- `status === "renewed"` → success; re-run `check_kerberos_ticket` to confirm a valid ticket is back in place.
- `status === "interactive"` → the ticket is not renewable (macOS path; or Windows when the helper is unavailable / disabled). Step 6's `wait_for_user_ack` will surface the `kinit <principal>` instruction and wait for the user's confirmation; the agent will **not** handle the password.
- `status === "failed"` → surface the tool's error message and continue to Step 7.

**Step 6 — Wait for user to complete interactive kinit**
Call `wait_for_user_ack` to pause until the user finishes the manual `kinit` step:

```yaml
prompt: "Your Kerberos ticket needs interactive renewal. Open a Terminal, run `kinit <your-principal>`, enter your password when prompted, and let me know when you're done. The agent never sees your password."
options:
  - { id: "done",    label: "I renewed the ticket",     kind: "primary" }
  - { id: "failed",  label: "kinit failed / cancelled", kind: "secondary" }
  - { id: "skip",    label: "Skip — leave ticket as-is", kind: "cancel" }
```

`Condition:` only run if Step 5 ran AND returned `status === "interactive"`. Skip silently if Step 5 completed via the helper (`"renewed"`) or failed for other reasons.

On `done`: re-run `check_kerberos_ticket` (re-fire Step 4) so Step 11's summary reflects the post-`kinit` state, not the stale interactive state.

**Step 7 — Enumerate client certificates**
Call `list_client_certificates` with `expiryWarnDays: 30`. The tool reports every personal / machine client cert with its expiry status.
- `status === "ok"` or `"empty"` → certs are not the problem; continue to Step 8.
- `status === "expired"` or `"expiring"` → surface the specific subjects/thumbprints to the user. Client certs cannot be silently renewed — they must be re-issued by the user's MDM or certificate authority. Point the user to their IT team with the specific cert details so the renewal request is actionable. Continue to Step 8 to verify remaining components; do NOT end the run yet.

**Step 8 — Capture VPN/SSO endpoint hostname (if user mentioned one)**
Call `request_user_input` to capture the failing VPN or SSO endpoint hostname when the user has reported endpoint-specific failures but the goal didn't include the hostname:

```yaml
prompt: "Which VPN or SSO endpoint is failing? Step 9 will check its TLS certificate to rule out a far-side expiry — server certs on the IdP/VPN gateway expiring look identical to a local identity problem and are a common false positive."
placeholder: "vpn.example.com or sso.example.com"
validator: "^[A-Za-z0-9.\\-]+$"
```

`Condition:` (goal-text test — no upstream tool flags this; evaluate against the raw goal string) only run if BOTH:
- (a) the goal matches the case-insensitive keyword regex `/\b(vpn|sso|saml|idp|gateway|endpoint|portal)\b/i` — i.e. the user named an endpoint class, not a generic "login is broken"; AND
- (b) the goal does NOT already contain a hostname token matching `/\b[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\b/` (an FQDN-style string with at least one dot, consistent with Step 9's `host` input and the `^[A-Za-z0-9.\-]+$` validator above).

Skip silently otherwise — Step 9 will use the goal-provided hostname directly (when (b) already matched) or skip entirely if no endpoint was named (when (a) did not match).

If the user submits an empty value, Step 9 skips (no false positive to rule out). Surface that gap in the Step 12 summary.

**Step 9 — Spot-check VPN/SSO certificate expiry**
Call `check_certificate_expiry` with `host` set to the captured hostname. An expiring server cert on the far side looks identical to a local identity problem.

`inputsFrom: [{ step: 8, field: "value" }]` (or use the goal-provided hostname if Step 8 was skipped).

`Condition:` only run if a valid hostname is available (either from Step 8's non-empty return or from the user's goal). Skip silently otherwise.

**Step 10 — Verify AD / domain binding (Windows AD environments)**
Call `check_ad_binding`. A broken binding causes symptoms that mimic every other auth failure at once, and cannot be repaired locally — escalate to helpdesk with the specific binding error.

`Condition:` always safe to run — on Entra-joined and non-domain-joined machines the tool cleanly returns "not domain-joined" without error. The result feeds Step 4's `missing` interpretation (does the machine expect Kerberos at all?).

**Step 11 — Summarise + guide the user**
Summarise what was found and what was fixed:
- NTP drift corrected → apps should start working within a few minutes as auth retries succeed.
- Kerberos TGT renewed (helper path or post-`kinit` ack) → file shares + SSO should work immediately; VPN may need a reconnect.
- Expired client cert → user must request re-issue from IT; no silent fix possible.
- Broken AD binding → user must contact IT; this skill cannot rebind.
- Failing endpoint cert (Step 9) → contact IT to renew the server cert; no client-side fix.
- Nothing obvious found → advise the user to restart their session (lock screen + sign in, or reboot if possible) so the OS re-acquires fresh credentials. If the user suspects network-layer issues (the endpoint can't reach the identity provider at all), escalate to the `network-reset` skill — this skill does not embed network probes. If that fails, escalate via the end-of-run ticket.

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
