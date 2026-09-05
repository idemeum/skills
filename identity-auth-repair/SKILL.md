---
name: identity-auth-repair
description: Diagnoses and repairs SSO / Kerberos / client-certificate authentication failures. Use when multiple identity-dependent apps (Outlook, VPN, Teams, Slack, corporate web apps) fail simultaneously — the root cause is often a single issue like NTP drift, an expired Kerberos TGT, or an expired client certificate. Fixes the underlying cause so all the downstream apps start working again.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - survey_identity
  - sync_system_time
  - renew_kerberos_ticket
  - list_client_certificates
  - check_ntp_status
  - check_kerberos_ticket
  - c_mdm_diagnose_configuration
  - c_mdm_reapply_configuration
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - survey_identity
  # Raised from medium when the MDM branch landed: c_mdm_reapply_configuration
  # is riskLevel high, and G2 blocks the whole plan when any step exceeds this
  # ceiling. The local correctives remain medium; the high step is the MDM
  # re-apply, which is consent-gated and non-destructive.
  maxAggregateRisk: high
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
---

## When to use

Use this skill when the user:
- Reports that **multiple** identity-dependent apps are failing auth at the same time (Outlook, VPN, Teams, Slack, corporate intranet, file shares)
- Gets "MFA code rejected" errors consistently
- Sees a Kerberos error message in any client (Outlook, file share, SSH)
- Mentions repeated auth failures after a known quiet period (laptop woke from sleep, travelled across time zones, came back from vacation)
- Cannot reach the Active Directory / LDAP / identity provider

Do NOT use this skill when:
- The user says they need to reset their Entra password — use `entra-password-reset`.
- The user's local Mac / Windows password is not working — this skill cannot help (the user cannot run the agent if they cannot log in to their machine). Direct them to IT helpdesk for an in-person / phone-based local password reset.
- Only one app is failing and the rest work — use the app-specific skill (`email-repair`, `vpn-repair`, etc.).

The big win of this skill is catching **NTP drift** as the root cause. A clock skew > 5 minutes silently breaks Kerberos, SAML, and TOTP simultaneously — users see "VPN and email and MFA are all broken" but the real fix is a single NTP resync.

---

## Steps

**Step 1 — Survey the four local causes**
Call `survey_identity`. One call returns all four things that break authentication locally, as separate fields:
- `ntp` — clock offset. `status: "drifted"` (over 5 minutes) is **root cause #1**: it breaks Kerberos, SAML and TOTP at the same time, which is exactly the "everything is broken at once" report. Surface it immediately as the likely single cause, and read the other three in that light — a drifted clock plus an expired ticket is usually one fault, not two.
- `kerberos` — `status` is `ok` / `expiring` / `expired` / `missing`. `missing` means no Kerberos credentials at all: normal on a Mac that is not AD-bound, a logon problem on Windows. Read `adBinding` before judging it.
- `certificates` — `status` `ok` / `empty` / `expiring` / `expired`. On expiry, name the specific subjects and thumbprints; the agent cannot issue a certificate, so re-issuance comes from MDM or the CA.
- `adBinding` — safe everywhere; on Entra-joined and non-domain machines it cleanly reports not domain-joined. A broken binding mimics every other auth failure at once and cannot be repaired locally — escalate with the specific error.

Any field may carry `status: "error"` when that one probe failed; the other three still stand and one of them may be the whole answer.

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

**Step 4 — Renew Kerberos ticket (if expiring or expired)**
Call `renew_kerberos_ticket`. G4 fires the consent gate automatically (`tool.meta.requiresConsent: true`) with the dry-run preview inside (`tool.meta.supportsDryRun: true`) — the preview shows `kinit -R` on macOS, `klist purge && gpupdate /force` on Windows.

`Condition:` only run if Step 1's `kerberos.status` is `"expiring"` or `"expired"`. Skip for `"ok"` (nothing to renew) and `"missing"` (no ticket to renew from — read `adBinding` instead: a domain-joined machine with no ticket needs interactive re-authentication, which the agent will not do).

**On Windows** with the privileged helper daemon installed (default), the op runs through the helper as `LocalSystem` and completes silently for **all users — admin and non-admin alike**. AD reissues a fresh TGT on next access.

**On macOS** the op is **not yet supported via the helper** in v1 fast-follow — Heimdal / MIT-KfM integration is deferred. The handler returns `helper-error` with `stderr: "Platform not supported"` on macOS; Step 5 will ack the user's interactive `kinit`.

Status outcomes:
- `status === "renewed"` → success; re-run `check_kerberos_ticket` to confirm a valid ticket is back in place.
- `status === "interactive"` → the ticket is not renewable (macOS path; or Windows when the helper is unavailable / disabled). Step 5's `wait_for_user_ack` will surface the `kinit <principal>` instruction and wait for the user's confirmation; the agent will **not** handle the password.
- `status === "failed"` → surface the tool's error message and continue.

**Step 5 — Wait for user to complete interactive kinit**
Call `wait_for_user_ack` to pause until the user finishes the manual `kinit` step:

```yaml
prompt: "Your Kerberos ticket needs interactive renewal. Open a Terminal, run `kinit <your-principal>`, enter your password when prompted, and let me know when you're done. The agent never sees your password."
options:
  - { id: "done",    label: "I renewed the ticket",     kind: "primary" }
  - { id: "failed",  label: "kinit failed / cancelled", kind: "secondary" }
  - { id: "skip",    label: "Skip — leave ticket as-is", kind: "cancel" }
```

`Condition:` only run if Step 4 ran AND returned `status === "interactive"`. Skip silently if Step 4 completed via the helper (`"renewed"`) or failed for other reasons.

On `done`: re-run `check_kerberos_ticket` so the closing summary reflects the post-`kinit` state, not the stale interactive state. This is the one place the fine-grained tool is called directly — the survey has already run and only this one field needs refreshing.

**Step 6 — Can MDM re-issue the certificate?**
`Condition:` only run if Step 1 reported the client certificates as expired or expiring. Skip entirely when certificates were fine — the fault is NTP, Kerberos or AD binding, and those are already handled.

Call `c_mdm_diagnose_configuration`. It reads enrollment, locates the device in the tenant, and returns the per-item states in one call. Every eligibility rule — reachable provider, readable serial, exactly one matching device, checked in within 7 days, at least one item in `failed` — is enforced inside the tool, so do not re-derive them here.

Only `outcome: "failed-items"` continues. On anything else, skip Steps 7–7 and escalate with the tool's `message` — it is already written for the user. On `stale-checkin` lead with the check-in age: a device that fell off management is more useful to IT than any symptom.

On `failed-items`, make the judgement the tool deliberately does not: **look through `items` for a SCEP / PKCS / certificate profile.**
- None present at all → this device does not get its client certificate from MDM. Stop and escalate with that finding. This is a real answer, not a failure.
- Present but absent from `failedItems` → it applied cleanly, so the expiry has another cause. Escalate rather than re-applying.
- Present in `failedItems` → name it; that is the likely cause. Quote its `stateReason` when set — it says *why* the profile failed.

**Step 7 — Re-apply the device's configuration**
`Condition:` only run if Step 6 found an assigned certificate profile that failed to apply. Call `c_mdm_reapply_configuration`. State plainly in the rationale that this tells the device to check in and re-apply **all** its assigned configuration, that it cannot issue a certificate IT has never authored a profile for, and that re-issuance completes asynchronously after the tool returns.

**Step 8 — Wait for the certificate to be re-issued**
`Condition:` only run if Step 7 returned `status: "ok"`. That proves only that the MDM accepted the request — it is not evidence a certificate was issued. Call `wait_for_user_ack`:

```yaml
prompt: "I've asked Intune to re-send your device's configuration, which should re-issue the certificate. That usually takes a minute or two. Tell me when to re-check."
options:
  - { id: "ready", label: "Ready — re-check now", kind: "primary" }
  - { id: "skip",  label: "Skip the re-check",    kind: "cancel" }
```

**Step 9 — Re-check the certificates**
`Condition:` only run if Step 8 returned `ready`. Call `list_client_certificates` again with `expiryWarnDays: 30` and compare against Step 1's `certificates`. A fresh certificate with a later expiry is the evidence the re-sync worked; an unchanged list means it did not — escalate with the profile named in Step 8. Never report the certificate as renewed on the strength of Step 7 alone; on `skip` at Step 8, report the sync as initiated and unverified.

**Step 10 — Summarise + guide the user**
Summarise what was found and what was fixed:
- NTP drift corrected → apps should start working within a few minutes as auth retries succeed.
- Kerberos TGT renewed (helper path or post-`kinit` ack) → file shares + SSO should work immediately; VPN may need a reconnect.
- Expired client cert → user must request re-issue from IT; no silent fix possible.
- Broken AD binding → user must contact IT; this skill cannot rebind.
- Nothing obvious found → advise the user to restart their session (lock screen + sign in, or reboot if possible) so the OS re-acquires fresh credentials. If the user suspects network-layer issues (the endpoint can't reach the identity provider at all), escalate to the `network-reset` skill — this skill does not embed network probes. If that fails, escalate via the end-of-run ticket.

---

## Edge cases

- **User travelled across time zones + laptop was asleep.** Wake-from-sleep + large time change is a classic NTP-drift trigger. Step 1 will catch it; Step 2 fixes it.
- **FileVault unlock uses a stale password.** Not this skill's territory — FileVault credentials are separate from cloud IDP and Kerberos credentials. If the user cannot even reach the login screen, direct them to their Recovery Key or IT.
- **MFA still fails after NTP fix.** TOTP codes depend on synced clocks. After Step 2, the user should wait ~30 seconds for a fresh code before retrying — an in-flight code was generated on the skewed clock and will still fail.
- **Kerberos ticket renewal succeeds but VPN still fails.** Some VPN clients hold a stale cached ticket. After a ticket renewal the user may need to disconnect + reconnect the VPN to pick up the fresh TGT.
- **Client cert expiring within 30 days.** Does not block auth TODAY but will in the near future. Still surface it to the user so they can schedule a renewal before it becomes an emergency.
- **Machine is Entra-joined (no traditional AD binding).** `check_ad_binding` will report "not domain-joined" — that's correct and expected on Entra-joined endpoints. Do NOT treat as a failure; proceed to the next step.
- **Hybrid AD + Entra with password writeback.** If the user just reset their cloud password and Kerberos still rejects, on-prem propagation can lag 15–30 min. Advise waiting before concluding Kerberos is broken.
- **Password is NOT collected by this skill.** All corrective tools avoid handling passwords: `renew_kerberos_ticket` uses `kinit -R` (no prompt) or surfaces "interactive" so the user runs `kinit` in their own terminal.
