# Printer not working or print queue stuck

**Skill:** `printer-repair` · **Risk:** medium · **Steps:** 10

Diagnoses and repairs printing issues including stuck print queues, offline printers, and CUPS/Spooler service failures. Clears jammed queues and restarts the print service; guides self-service + IT escalation for driver/config corruption.

## What it does, step by step

**Step 1.** Lists all printers and their current status and connection type.
_read-only_ · `list_printers`

**Step 2.** Checks every print queue for stuck, held, or errored jobs.
_read-only_ · `check_print_queue`

**Step 3.** Asks for the printer's IP address or hostname if it can't be found automatically.
_no tools, conditional_

**Step 4.** Tests whether the printer can be reached over the network.
_read-only, conditional_ · `check_printer_connectivity`

**Step 5.** Clears stuck or jammed jobs from all print queues after showing what will be removed.
_deletes data, asks permission, preview first, conditional_ · `clear_print_queue`

**Step 6.** Confirms whether the print queue is now empty.
_read-only, conditional_ · `check_print_queue`

**Step 7.** Restarts the print service to fix a stopped or unresponsive printer.
_no tools, conditional_

**Step 8.** Rechecks printer status after the restart to see if it's fixed.
_read-only, conditional_ · `list_printers`

**Step 9.** Asks the user to send a real print job and confirm it printed successfully.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 10.** Summarizes what was checked and fixed, plus any next steps needed.
_no tools_

## Tools it may use

`list_printers`, `check_print_queue`, `check_printer_connectivity`, `clear_print_queue`, `restart_cups`, `request_user_input`, `wait_for_user_ack`
