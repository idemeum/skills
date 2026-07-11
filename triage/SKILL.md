---
name: triage
description: Collects structured intake information when no specific skill matches the user's IT request. Presents the issue classified into category, urgency, affected system, and symptoms for user review. Ticket submission is handled by the existing post-execution createTicket() path.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - present_intake_form
  - check_connectivity
  - get_top_consumers
  - list_installed_apps
  - list_usb_devices
  - check_firewall_status
  - check_mail_account_config
  - list_printers
  - get_processes
metadata:
  maxAggregateRisk: low
  userLabel: "Submit issue to IT helpdesk"
  examples: []
  pill:
    label: Report Issue
    goal: I need to report an IT issue that doesn't match a known category
    icon: ClipboardList
    iconClass: text-amber-500
    order: 99
---

## When to use

This skill is selected automatically by runtime.ts when the skill router exhausts its clarification rounds without matching a skill (the "unclear" branch). It is NOT router-matched — the `examples` list is intentionally empty.

Do NOT select this skill if the user's request clearly matches another skill — this is a last-resort fallback only.

---

## Steps

**Step 1 — Present intake form for user review**

Call `present_intake_form` with fields extracted from the user's description and clarification answers. The accumulated context from the clarification rounds is available in the conversation — extract the structured fields below from it.

```yaml
title: "Review your IT request"
category: "<extracted category>"
urgency: "<extracted urgency>"
summary: "<extracted summary>"
affectedSystem: "<extracted system>"
symptoms: ["<symptom 1>", "<symptom 2>"]
```

### Executor guidance

Extract each field from the user's original request and any clarification answers they provided:

**category** — Map to exactly one of these values:
- `Network` — Wi-Fi, Ethernet, VPN, DNS, connectivity, firewall, proxy
- `Software` — app crashes, installation, updates, licensing, compatibility
- `Hardware` — laptop, monitor, keyboard, mouse, dock, USB, Bluetooth, audio/video peripherals
- `Account/Access` — login, password, MFA, SSO, permissions, locked account
- `Email` — Outlook, mail delivery, calendar, contacts, mailbox size
- `Printing` — printer setup, print queue, paper jam, scanning
- `Performance` — slow computer, high CPU/memory, fan noise, overheating
- `Security` — malware, suspicious activity, data loss, encryption
- `Other` — anything that does not fit the categories above

When the user's description spans multiple categories, pick the one that best matches the root cause. Default to `Other` when genuinely ambiguous.

**urgency** — Classify based on business impact:
- `critical` — system or account completely unusable, user cannot work at all
- `high` — significant workflow impact, major feature broken, no workaround
- `medium` — inconvenience with a workaround available, partial functionality
- `low` — cosmetic issue, informational question, nice-to-have request

When the user has not described impact severity, default to `medium`.

**summary** — Write a 1-2 sentence plain-English summary that an IT helpdesk technician would understand without seeing the original conversation. Include the what (symptom), the where (system/app), and the when (if the user mentioned timing).

**affectedSystem** — The primary application, device, or service affected. Use the common name (e.g. "Outlook" not "Microsoft Outlook for Mac", "Wi-Fi" not "802.11ac wireless"). When the user mentions a broad target like "my computer" or "my laptop", write the most specific term they used (e.g. "Laptop", "Desktop", "MacBook"). Write "Unknown" only when absolutely nothing can be inferred.

**symptoms** — List of specific symptoms the user described, each as a short phrase. If the user's description was vague, extract what you can and include at least one entry. Empty array only when absolutely nothing can be inferred.

**Step 2 — Collect category-specific diagnostics**

After the intake form is submitted, run one diagnostic tool matching the classified category. The planner selects the tool based on the category:

- `Network` → call `check_connectivity`
- `Software` → call `list_installed_apps`
- `Hardware` → call `list_usb_devices`
- `Account/Access` → call `get_processes`
- `Email` → call `check_mail_account_config`
- `Printing` → call `list_printers`
- `Performance` → call `get_top_consumers`
- `Security` → call `check_firewall_status`
- `Other` → call `get_processes`

Call the selected tool with default arguments. Only after the intake form is submitted (action is not "cancel").

---

## Edge cases

- **Vague user input** — When the accumulated context is sparse (e.g. "something broke"), do your best: category `Other`, urgency `medium`, summary paraphrasing the original goal, affectedSystem from the broadest term the user mentioned (e.g. "Computer", "Laptop") — never default to "Unknown" unless the user gave zero context, symptoms with at least the user's own words. The form is editable — the user can correct urgency, summary, affected system, and symptoms. Category is read-only (set by the planner's classification) because the diagnostic step is tied to it.
- **User cancels the form** — The gate returns `action: "cancel"`. The run completes with no corrective action and `runStatus` will be `unresolved`. A ticket is still created via the post-execution path but with empty diagnostics.
- **Ticketing disabled** — The gate injects `ticketingEnabled: false` from deployment config. The card heading changes to informational and the Submit button is hidden, but the user can still copy the structured summary. The run still completes normally.
