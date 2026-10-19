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

Reached when the user taps the Report Issue pill or accepts a "Raise with IT" offer; when they ask for a human directly — that is what the `examples` list is for, and those phrasings are deliberately escalation-only so they cannot compete with a real skill; or when they make a clear IT request that no other skill handles ("I need a new laptop"), which the skill router sends here. A request too vague to tell what is wrong gets a question instead, not this skill.

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

**Step 2 — Record the triage for the user to review**

Call `c_record_triage` with `category: ["<the category you picked>"]`. It shows the record to the user on the intake form, to review before anything is sent to IT.

### Executor guidance

Write every other field from the user's request, any clarification answers, the knowledge-base answer and what Step 1 found:
- kind — issue: something is broken; request: something is wanted.
- urgency — critical: the user cannot work at all; high: significant impact, no workaround; medium: a workaround exists; low: cosmetic or a question. When the user has not described the impact, medium.
- categoryCertainty, urgencyCertainty — 0–100, how sure you are.
- issueSummary — 1–2 sentences a helpdesk technician understands without the conversation: what, where, since when.
- affectedSystem — the app, device or service by its common name ("Outlook", not "Microsoft Outlook for Mac"; "Wi-Fi", not "802.11ac wireless"). For a broad target like "my laptop", the most specific term the user used ("Laptop", "MacBook"). "Unknown" only when nothing can be inferred.
- symptoms — short phrases, at least one when anything can be inferred. tags — keywords.
- sentiment — the user's tone: neutral, frustrated or urgent.
- entities — persons, devices, software, vendors, locations and accounts the user named — each a list, empty when none. Never a password or other secret.
- evidence — one entry for Step 1: the tool, why it ran ("Category Network"), and what it showed in plain words ("DNS lookups fail; the gateway answers").
- recommendations — nextSteps: what IT should try first; alerts: { type, detail } for a security concern or a frustrated user, empty otherwise.
- automation — score 0–100: how much of this the device's connectors could have done; relevantConnectors: which ones; recommendation: the skill worth writing, or "".

---

## Edge cases

- **Vague user input** — When the description is sparse ("something broke"), do your best: category `Other`, urgency `medium`, issueSummary paraphrasing the request, affectedSystem from the broadest term the user mentioned ("Computer", "Laptop") — never "Unknown" unless the user gave no context — and symptoms with at least the user's own words. The user can correct urgency, the issue summary, the affected system and the symptoms on the form; category is read-only, because the diagnostic already ran for it.
- **User cancels the form** — The gate returns `action: "cancel"`. The diagnostic has already run; its output stays on the ticket, so IT can see what was checked. Nothing is sent to the helpdesk.
- **Ticketing disabled** — The gate injects `ticketingEnabled: false` from deployment config. The card heading changes to informational and the Submit button is hidden, but the user can still copy the structured summary. The run still completes normally.
