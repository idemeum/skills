# Submit issue to IT helpdesk

**Skill:** `triage` · **Risk:** low · **Steps:** 2

Collects structured intake information when no specific skill matches the user's IT request. Presents the issue classified into category, urgency, affected system, and symptoms for user review. Ticket submission is handled by the existing post-execution createTicket() path.

## What it does, step by step

**Step 1.** Shows a summary of the request's category, urgency, system, and symptoms for confirmation.
_asks the user, conditional_ · `present_intake_form`

**Step 2.** Gathers extra technical details relevant to the issue's category to aid troubleshooting.
_read-only_ · `check_connectivity`, `list_installed_apps`, `list_usb_devices`, `get_processes`, `check_mail_account_config`, `list_printers`, `get_top_consumers`, `check_firewall_status`

## Tools it may use

`present_intake_form`, `check_connectivity`, `get_top_consumers`, `list_installed_apps`, `list_usb_devices`, `check_firewall_status`, `check_mail_account_config`, `list_printers`, `get_processes`
