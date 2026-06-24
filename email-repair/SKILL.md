---
name: email-repair
description: Diagnoses and repairs email client issues including account configuration, authentication/credential failures, index corruption, database errors, SMTP/IMAP connectivity failures, and permission problems. Use when user reports email not sending, not receiving, repeated password prompts, missing messages, or client crashes.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_mail_account_config
  - check_smtp_connectivity
  - check_certificate_expiry
  - get_top_consumers
  - check_mail_permissions
  - get_cached_credentials_count
  - repair_keychain
  - rebuild_mail_index
  - repair_outlook_database
  - reset_app_preferences
  - wait_for_user_ack
  - request_user_input
metadata:
  prerequisites:
    before-corrective:
      - check_mail_account_config
      - check_smtp_connectivity
      - check_certificate_expiry
      - get_top_consumers
  maxAggregateRisk: high
  userLabel: "Email not working"
    # Crash/freeze examples stay EMAIL-scoped (Outlook/Mail + a mail action) so they
    # don't read as a generic app crash — a crash-every-launch is software-reinstall,
    # a one-off frozen app is process-manager.
  examples:
    - "my email is not sending or receiving"
    - "Outlook crashes whenever I open my inbox"
    - "I keep getting asked for my email password"
    - "Outlook freezes when sending or receiving mail"
    - "email stopped working this morning"
  pill:
    label: Fix Email
    goal: My email is not working, please diagnose and fix the issue
    icon: Mail
    iconClass: text-blue-500
    order: 2
---

## When to use

Use when the user: can't send or receive email; their client (Mail, Outlook) crashes or hangs; messages are missing/duplicated; they get **repeated password prompts / authentication failures**; or "cannot connect to server" errors.

Do NOT use for general no-internet problems — run the `network-reset` skill first if the user has no internet at all.

**Pattern — diagnostic-driven escalation.** Read the account config → test the server → check the process/permissions → capture the symptom → run the *matched* corrective (lightest first: re-auth → index/DB repair → preferences reset) → verify. G4 gates every destructive action (dry-run preview + consent); the user can abort mid-escalation.

---

## Steps

> **Authoring rule:** one tool call per step, plain integer numbering. Conditional/follow-up tool calls get their own numbered step (the planner drops or mis-sequences steps that bundle two tools). Every `wait_for_user_ack` has **at most 4 options** (schema-enforced — a 5th makes the tool reject the whole call).

**Step 1 — Read account configuration**
Call `check_mail_account_config` with `client: "auto"`. Returns `output.client` (`"mail" | "outlook" | "unknown"`) and `output.accounts: [{ email, imapServer, smtpServer, port, ssl }]`. On macOS, `auto` probes **both** clients and resolves `output.client` to whichever has accounts configured — detection is by accounts, not app presence (Mail.app always exists on macOS), so the Outlook path (Step 12) is reachable for Outlook users. `port`/`ssl` are the **IMAP** values (no SMTP port/ssl is returned).

Infer each account's provider from the email domain / `imapServer` — gmail.com/googlemail.com → gmail; outlook/hotmail/live/office365/onmicrosoft → office365; icloud/me/mac → icloud; else other. Compare against this known-good reference (authoritative — do NOT use memorised settings); flag any mismatch:

| Provider | `imapServer` | `smtpServer` | IMAP `port` | `ssl` |
|---|---|---|---|---|
| gmail | `imap.gmail.com` | `smtp.gmail.com` | `993` | `true` |
| office365 | `outlook.office365.com` | `smtp.office365.com` | `993` | `true` |
| icloud | `imap.mail.me.com` | `smtp.mail.me.com` | `993` | `true` |

For `other` there is no baseline — only sanity-check `ssl === true`, a standard secure port (`993`, or `143` with STARTTLS), and non-empty hosts; advise verifying against the provider's docs.

If `output.client === "unknown"` or `output.accounts` is empty, no config could be read (on macOS Mail this is usually a missing Automation grant — surface `output.error`); get the server host via Steps 2–3.

**Step 2 — Provider fallback (only when no config)**
**Condition:** only if Step 1 returned no accounts AND the goal doesn't already name an SMTP host.
Call `wait_for_user_ack`:

```yaml
prompt: "Which email provider does the affected account use?"
options:
  - { id: "gmail",     label: "Gmail",                   kind: "primary" }
  - { id: "office365", label: "Outlook / Microsoft 365", kind: "primary" }
  - { id: "icloud",    label: "iCloud",                  kind: "secondary" }
  - { id: "other",     label: "Company / Other",         kind: "secondary" }
```

Map for Step 4: gmail → `smtp.gmail.com`, office365 → `smtp.office365.com`, icloud → `smtp.mail.me.com`.

**Step 3 — SMTP host for "Company / Other"**
**Condition:** only if Step 2 ran AND `choice === "other"`. `inputsFrom: [{ step: 2, field: "choice" }]`.
Call `request_user_input`:

```yaml
prompt: "What's your outgoing mail server (SMTP) hostname?"
placeholder: "smtp.acme.com"
validator: "^[A-Za-z0-9.\\-]+$"
```

Empty value → end politely ("I can't test mail-server connectivity without a hostname — try restarting your client or contact IT").

**Step 4 — Test mail-server connectivity**
Call `check_smtp_connectivity` with the SMTP host from Step 1 (`output.accounts[].smtpServer`), the Step 2 mapping, or Step 3. It tests ports 587 / 465 / 25.

**Step 5 — Check the mail-server certificate**
Call `check_certificate_expiry` with the same host as Step 4 and **`port: 465`** (the implicit-TLS submission port; the `443` default and STARTTLS `587` don't serve a direct handshake and return `output.error`). Read it as: `output.isExpired === true` with **no** `output.error` = genuinely expired cert (a real cause); any `output.error` = could-not-verify (inconclusive — do NOT report "expired").

**Step 6 — Check the client isn't hung**
Call `get_top_consumers` with `metric: "combined"`, `limit: 10`. If `output.processes` contains `Mail` / `Microsoft Outlook` / `Outlook` with `cpuPercent > 20` OR `memoryMb > 500`, the hung process is the cause — route to the `process-manager` skill, don't continue correctives.

**Step 7 — Check / fix file permissions (macOS Mail only)**
**Condition:** only if `output.client === "mail"`.
Call `check_mail_permissions` (read-only). If `output.tccBlocked === true`, this is a Full Disk Access (TCC) block, NOT a fixable permission problem — surface `output.message`, point to System Settings → Privacy & Security → Full Disk Access, and do NOT run the fix. Else if `output.permissionsOk === false`, re-call with `fix: true` (touches only the user's own `~/Library/Mail`). If it still returns `output.fixed === false`, escalate per Graceful degradation #3.

**Step 8 — Capture the symptom (drives the corrective)**
Call `wait_for_user_ack`. The returned `choice` is the binding signal for Steps 9–12 — no free-text inference:

```yaml
prompt: "What's actually going wrong? This decides which repair I run."
options:
  - { id: "auth-or-send",    label: "Password prompts, or can't send/receive", kind: "primary" }
  - { id: "index-corrupt",   label: "Slow, wrong counts, or missing messages", kind: "primary" }
  - { id: "client-crashing", label: "Crashing, hanging, or data errors",       kind: "secondary" }
  - { id: "skip",            label: "Not sure / skip",                         kind: "cancel" }
```

**Condition:** only if a corrective could apply — `output.client ∈ {"mail","outlook"}`, or connectivity/auth is the suspected cause. On `skip`/`timeout`, run no symptom-driven corrective (Step 11 may still fire via the Step 7 permission-fix branch).

**Step 9 — Check for stale cached credentials**
**Condition:** only if Step 8 `choice === "auth-or-send"`.
Call `get_cached_credentials_count` with the mail-server domains from Step 1 (e.g. `imap.gmail.com`). `output.totalCount > 0` means stale credentials may be cached — informs the Step 10 re-auth. Read-only, no gate.

**Step 10 — Credential / re-auth fix** *(lightest corrective; the most common cause)*
**Condition:** only if Step 8 `choice === "auth-or-send"`.
Call `repair_keychain` with `action: "repair"` — this **locks** the login keychain so the next app access re-prompts once with the current password (non-interactive; clears a post-password-change desync). G4 gates it. After it runs (`output.repaired`), guide the user to re-enter their password / remove and re-add the account using the provider's "Sign in with Google/Microsoft" flow. **In the rationale**, add: if this is a **work / SSO account** (corporate Okta / Entra / Google sign-in), the password lives at the identity provider and no client-side repair helps — point them to the `cloud-idp-password-reset` skill.

**Step 11 — Rebuild mail index (Apple Mail)**
**Condition:** only if `output.client === "mail"` AND (Step 8 `choice === "index-corrupt"` OR `choice === "client-crashing"` OR Step 7's permission fix ran).
Call `rebuild_mail_index` (G4 gates it). In the rationale: Mail quits and rebuilds the index on next launch — no messages are deleted (the index regenerates from the message store). Warn that a large mailbox (100k+) can take 10–60 minutes. If `output.tccBlocked === true`, the index could not be read/removed because Full Disk Access isn't granted — surface `output.message` (FDA guidance) and do NOT report the rebuild as done; treat it like the Step 7 TCC block.

**Step 12 — Repair Outlook database (Outlook)**
**Condition:** only if `output.client === "outlook"` AND Step 8 `choice === "client-crashing"` (or the goal explicitly cites Outlook crashes/corruption).
Call `repair_outlook_database` (G4 gates it). Carry the **"quit Outlook before confirming"** warning in the step **rationale** (it renders on the gate cards) — NOT in the response (generated post-confirm, too late to act on). The tool also prefixes a warning when `output.outlookRunning === true` and **refuses** at execute time while Outlook is open (returns a "still running" `output.message`) — relay it, have the user quit Outlook, then re-run.

**Step 13 — Verify after the first corrective**
**Condition:** only if a corrective ran (Step 7 fix, 10, 11, or 12).
Call `wait_for_user_ack`:

```yaml
prompt: "Relaunch your email client and check — is email working now?"
options:
  - { id: "works",        label: "Working now",       kind: "primary" }
  - { id: "still-broken", label: "Still not working", kind: "secondary" }
  - { id: "skip",         label: "I'll test later",   kind: "cancel" }
```

`works` → report success (Step 16); do NOT escalate. `still-broken` → Step 14. `skip`/`timeout` → don't reset on a guess; surface the diagnostic packet for IT.

**Step 14 — Reset preferences (last resort)**
**Condition:** only if Step 13 returned `still-broken`, OR the user explicitly asked to reset preferences.
Call `reset_app_preferences` with `appName: "Mail"` (Apple Mail) or `appName: "Outlook"` (Outlook) — use `"Outlook"`, not `"Microsoft Outlook"` (the tool matches the `com.microsoft.Outlook` preference domain). G4 gates it. Carry the warning in the **rationale** (not the response): this clears the client's app preferences (signatures, rules, smart mailboxes, layout) — the tool backs each file up to a `.bak` first, so it's reversible — and does NOT remove the user's accounts (they persist in Internet Accounts / the Outlook Group Container).

**Step 15 — Final verify (after reset)**
**Condition:** only if Step 14 ran.
Call `wait_for_user_ack` ("Relaunch and try sending/receiving — working now?"; options `works` / `still-broken` / `skip`). `works` → success. `still-broken` → in-scope correctives are exhausted; surface the diagnostic packet for IT (Graceful degradation).

**Step 16 — Final report**
Summarise the steps that ran, their outcomes, and any IT-escalation recommendation.

---

## Graceful degradation (root cause outside the user's mail data)

All tools run in user space (no admin). When the cause is server-side or IT-managed:

1. **Account locked / suspended / server-side password expired (Exchange / M365):** no client-side repair recovers it — send the user to IT with the Step 4–5 connectivity + certificate diagnostics.
2. **MDM-pushed mail profile:** `reset_app_preferences` clears only client-side prefs; the profile re-applies on next launch. Tell the user it's IT-managed (change via Jamf / Intune or an admin).
3. **Root-owned Mail files (rare, post-migration):** if `check_mail_permissions` with `fix: true` still returns `output.fixed === false`, surface `output.mailDir` / `output.owner` and have the user run `sudo chown -R $USER ~/Library/Mail` themselves — do NOT run sudo via the agent.
4. **Outlook DB beyond local repair:** if `repair_outlook_database` can't repair, re-create the profile (Outlook → Account Settings → remove + re-add). M365/Exchange re-downloads from the server (no data loss); POP has no server copy — escalate to IT first.
5. **Escalation packet:** Steps 1, 4, 5, 7 (config, connectivity, cert, permissions) plus any repair attempt are captured on the end-of-run ticket for a clean tier-1 handoff.

## Edge cases

- **Connectivity fine but still failing** = almost always credentials/auth → Step 10 (TCP success does not validate credentials).
- **Exchange / EWS:** Outlook-for-Mac uses EWS, not IMAP/SMTP, so `check_smtp_connectivity` is irrelevant — check the Exchange host on port 443 instead.
- **Corporate mail over VPN:** an internal Exchange host needs VPN connected first; check with `check_vpn_status` if the host is internal.
