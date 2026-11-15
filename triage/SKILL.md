---
name: triage
description: Collects structured intake information when no specific skill matches the user's IT request. Presents the issue classified into category, urgency, affected system, and symptoms for user review. Ticket submission is handled by the existing post-execution createTicket() path.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_connectivity
  - get_top_consumers
  - list_installed_apps
  - list_usb_devices
  - check_firewall_status
  - check_mail_account_config
  - list_printers
  - get_processes
  # Account lookups — every provider a tenant might use. Each run keeps only
  # the verified user's provider and drops the rest, or all of them with no
  # verified user (TRIAGE-ARCHITECTURE.md § Tools a run does not have).
  - c_entra_get_user_info
  - c_entra_get_mfa_status
  - c_entra_get_sign_in_logs
  - c_okta_get_user
  - c_okta_get_mfa_status
  # Device lookups — each uses the MDM or RMM that manages this machine
  # (managedBy); the planner leaves out one that no provider serves here.
  - c_mdm_diagnose_configuration
  - c_rmm_diagnose_device
  - c_record_triage
metadata:
  maxAggregateRisk: low
  userLabel: "Submit issue to IT helpdesk"
  examples:
    - get me a human
    - I need to talk to IT
    - can someone from IT call me
    - I want to raise a ticket
    - just escalate this to IT
  pill:
    label: Report Issue
    goal: I need to report an IT issue that doesn't match a known category
    icon: ClipboardList
    iconClass: text-amber-500
    order: 99
  # OPTIONAL — your ticketing system's own values (TRIAGE-ARCHITECTURE.md
  # § Frontmatter). Shipped without them, so nothing is written to a ticket's
  # category or urgency on any system; triage still classifies, and the note
  # still shows what it chose. To have triage set them, add a `triage:` block
  # here — start from examples/connectwise.triage.yaml or
  # examples/halopsa.triage.yaml in this folder — then upload the file as a
  # custom skill named `triage`, which replaces this one. Its shape:
  #
  # triage:
  #   categories:          # ConnectWise: type › subtype › item on your board;
  #     Hardware:          #   HaloPSA: your categories. A path may stop at any level.
  #       Laptop: [Battery, Screen]
  #   urgency:             # ConnectWise: High | Medium | Low. HaloPSA: urgency IDs.
  #     critical: High
  #     high: High
  #     medium: Medium
  #     low: Low
  #   ticketUpdates:       # optional; both thresholds default to 80
  #     minCertainty: { category: 80, urgency: 80 }
  #     neverSet: { urgency: [critical] }
---

## When to use

Reached from the Report Issue pill, an accepted "Raise with IT" offer, a request for a human, or a clear IT request no other skill handles ("I need a new laptop").

Do NOT select this skill if the user's request clearly matches another skill — this is a last-resort fallback only.

---

## Steps

Pick the category first — the one that best matches the root cause when the description spans several; `Other` when genuinely ambiguous:
- `Network` — Wi-Fi, Ethernet, VPN, DNS, connectivity, firewall, proxy
- `Software` — app crashes, installation, updates, licensing, compatibility
- `Hardware` — laptop, monitor, keyboard, mouse, dock, USB, Bluetooth, audio/video peripherals
- `Account/Access` — login, password, MFA, SSO, permissions, locked account
- `Email` — Outlook, mail delivery, calendar, contacts, mailbox size
- `Printing` — printer setup, print queue, paper jam, scanning
- `Performance` — slow computer, high CPU/memory, fan noise, overheating
- `Security` — malware, suspicious activity, data loss, encryption
- `Other` — anything that does not fit the categories above

**Step 1 — Run the diagnostic for the category**

Run the one read-only diagnostic for the category you picked, with default arguments:

- `Network` → call `check_connectivity`
- `Software` → call `list_installed_apps`
- `Hardware` → call `list_usb_devices`
- `Account/Access` → call `get_processes`
- `Email` → call `check_mail_account_config`
- `Printing` → call `list_printers`
- `Performance` → call `get_top_consumers`
- `Security` → call `check_firewall_status`
- `Other` → call `get_processes`

Then that category's lookups, and only those:

| Category | Steps | Step 8 `facets` |
|---|---|---|
| `Account/Access`, `Email` | 2–6 | |
| `Network` | 7, 8 | info, alerts |
| `Software` | 7, 8 | alerts, patches |
| `Hardware` | 7, 8 | info, disks |
| `Performance` | 7, 8 | health, alerts, disks |
| `Security` | 7, 8 | health, disks |
| `Printing`, `Other` | none | |

Leave out a step whose tool is not in your allowed tools, or that the Environment block says cannot run here.

**Step 2 — Entra: the account**

Call `c_entra_get_user_info`: enabled or locked.

**Step 3 — Entra: MFA**

Call `c_entra_get_mfa_status`: the methods registered.

**Step 4 — Entra: sign-ins**

Only when the problem is failing sign-ins, call `c_entra_get_sign_in_logs`.

**Step 5 — Okta: the account**

Call `c_okta_get_user`: enabled or locked.

**Step 6 — Okta: MFA**

Call `c_okta_get_mfa_status`: the methods registered.

**Step 7 — MDM: the device**

Call `c_mdm_diagnose_configuration` with `states: "compliance"`. It finds this device in its MDM and reports compliance and failed items; for `Network`, a non-compliant device or a failed certificate or profile often stops VPN or corporate Wi-Fi.

**Step 8 — RMM: the device**

Call `c_rmm_diagnose_device` with the category's `facets` from the table.

**Step 9 — Record the triage for the user to review**

Call `c_record_triage` with `category: ["<the category you picked>"]`. It shows the record to the user on the intake form, to review before anything is sent to IT.

### Executor guidance

Write every other field from the user's request, the knowledge-base answer and what Steps 1–8 found:
- kind — issue: something is broken; request: something is wanted.
- urgency — critical: the user cannot work at all; high: significant impact, no workaround; medium: a workaround exists; low: cosmetic or a question. When the user has not described the impact, medium.
- categoryCertainty, urgencyCertainty — 0–100, how sure you are.
- issueSummary — 1–2 sentences a helpdesk technician understands without the conversation: what, where, since when.
- affectedSystem — the app, device or service by its common name ("Outlook", not "Microsoft Outlook for Mac"; "Wi-Fi", not "802.11ac wireless"). For a broad target like "my laptop", the most specific term the user used ("Laptop", "MacBook"). "Unknown" only when nothing can be inferred.
- symptoms — short phrases, at least one when anything can be inferred. tags — keywords.
- sentiment — the user's tone: exactly one of neutral, frustrated or angry.
- entities — persons, devices, software, vendors, locations and accounts the user named — each a list, empty when none. Never a password or other secret.
- evidence — one entry per tool that ran in Steps 1–8: the tool, why it ran ("Category Network", "Account lookup", "Device lookup"), and what it showed in plain words ("DNS lookups fail; the gateway answers", "Account locked since 09:12", "Non-compliant: disk encryption off"). Write findings only from what the tool returned — never from the step's rationale or what it was meant to check. A device lookup that found nothing says why ("not enrolled in MDM", "Not found in NinjaOne") — record that as its finding.
- recommendations — nextSteps: what IT should try first; alerts: { type, detail } for a security concern or a frustrated user, empty otherwise.
- automation — score 0–100: how much of this the device's connectors could have done; relevantConnectors: which ones; recommendation: the skill worth writing, or "".

---

## Edge cases

- **Vague user input** — When the description is sparse ("something broke"), do your best: category `Other`, urgency `medium`, issueSummary paraphrasing the request, affectedSystem from the broadest term the user mentioned ("Computer", "Laptop") — never "Unknown" unless the user gave no context — and symptoms with at least the user's own words. The user can correct urgency, the issue summary, the affected system and the symptoms on the form; category is read-only, because the diagnostic already ran for it.
- **No verified user** — The account lookups are not offered. Record from the request, Step 1 and any device lookup, and say in recommendations that the account could not be checked.
- **Device not found** — The device lookup reports why (not enrolled, serial not found, more than one match). Record that as found; do not guess the device's state.
