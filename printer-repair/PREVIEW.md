# Printer not working or print queue stuck

**Skill:** `printer-repair` · **Risk:** medium · **Steps:** 10

Diagnoses and repairs printing issues including stuck print queues, offline printers, and CUPS/Spooler service failures. Clears jammed queues and restarts the print service; guides self-service + IT escalation for driver/config corruption.

## What it does, step by step

**Step 1.** Lists all configured printers and their current status to spot problems.
_read-only_ · `list_printers`

**Step 2.** Scans every print queue for stuck, paused, or errored jobs.
_read-only_ · `check_print_queue`

**Step 3.** Asks for the printer's network address when it can't be found automatically.
_no tools, conditional_

**Step 4.** Tests whether the printer is reachable on the network or offline.
_read-only, conditional_ · `check_printer_connectivity`

**Step 5.** Clears jammed or stuck print jobs from all queues after user confirmation.
_deletes data, asks permission, preview first, conditional_ · `clear_print_queue`

**Step 6.** Confirms whether the queue is now empty after clearing stuck jobs.
_read-only, conditional_ · `check_print_queue`

**Step 7.** Restarts the print service to fix a stopped, offline, or malfunctioning printer.
_makes a change, asks permission, preview first, conditional_ · `restart_cups`

**Step 8.** Rechecks printer status after the restart to see if it's now working.
_read-only, conditional_ · `list_printers`

**Step 9.** Asks the user to send a real test print and confirm it worked.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 10.** Summarizes the diagnostics performed, the outcome, and any next steps needed.
_no tools_

## Tools it may use

`list_printers`, `check_print_queue`, `check_printer_connectivity`, `clear_print_queue`, `restart_cups`, `request_user_input`, `wait_for_user_ack`
