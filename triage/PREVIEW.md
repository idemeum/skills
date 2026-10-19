# Submit issue to IT helpdesk

**Skill:** `triage` · **Risk:** low · **Steps:** 2

Collects structured intake information when no specific skill matches the user's IT request. Presents the issue classified into category, urgency, affected system, and symptoms for user review. Ticket submission is handled by the existing post-execution createTicket() path.

## What it does, step by step

**Step 1.** Runs one read-only check for the selected category to gather relevant system details.
_read-only_ · `check_connectivity`, `list_installed_apps`, `list_usb_devices`, `get_processes`, `check_mail_account_config`, `list_printers`, `get_top_consumers`, `check_firewall_status`

**Step 2.** Records the categorized issue details for the user to review before IT submission.
_asks the user, conditional_ · `c_record_triage`

## Tools it may use

`check_connectivity`, `get_top_consumers`, `list_installed_apps`, `list_usb_devices`, `check_firewall_status`, `check_mail_account_config`, `list_printers`, `get_processes`, `c_record_triage`
