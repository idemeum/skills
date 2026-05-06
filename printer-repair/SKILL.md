---
name: printer-repair
description: Diagnoses and repairs printing issues including stuck print queues, offline printers, CUPS/Spooler service failures, driver problems, and network printer connectivity. Use when a printer is not printing, showing as offline, or the print queue is jammed.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - list_printers
  - check_print_queue
  - clear_print_queue
  - check_printer_connectivity
  - restart_cups
  - remove_printer
  - add_printer
  - reset_printing_system
metadata:
  prerequisites:
    before-corrective:
      - list_printers
      - check_print_queue
      - check_printer_connectivity
  maxAggregateRisk: high
  userLabel: "Printer not working or print queue stuck"
  examples:
    - "my printer won't print anything"
    - "the print queue is stuck"
    - "my printer is showing as offline"
    - "I can't get anything to print"
    - "printer is not responding to jobs"
  pill:
    label: Printer Issue
    goal: My printer isn't working or the queue is stuck — diagnose what's wrong and either fix it, give me the self-service steps, or escalate to IT
    icon: Printer
    iconClass: text-orange-500
    order: 5
---

## When to use

Use this skill when the user:
- Sends a print job but nothing comes out of the printer
- Reports the printer shows as "Offline" or "Error" in the system
- Has jobs stuck in the print queue that cannot be cancelled normally
- Reports the printer was working and stopped after a macOS/Windows update
- Wants to add a network printer or re-add one that was removed
- Asks "why won't my printer work?" or "my print queue is stuck"

Do NOT use this skill if the printer's power light is off or it shows a hardware error on its display panel — those are hardware issues that require physical intervention, not software repair.

---

## Steps

**Step 1 — Inventory configured printers**
Call `list_printers` to see all configured printers, their status (idle, processing, stopped, error), and queue depths. This immediately shows whether the printer is configured, what state it is in, and whether there are stuck jobs.

**Step 2 — Check the print queue**
Call `check_print_queue` for the affected printer. If there are stuck or error-state jobs, they must be cleared before new jobs can print. A single stuck job can block all subsequent jobs indefinitely.

**Step 3 — Clear stuck jobs**
If stuck jobs are present, call `clear_print_queue` with `dryRun: true` to show which jobs would be cancelled. If the user confirms (and does not need those jobs), call `clear_print_queue` with `dryRun: false`. After clearing, call `check_print_queue` again to confirm the queue is empty.

**Step 4 — Check printer network connectivity**
Call `check_printer_connectivity` with `host` set to the printer's IP address or hostname. The `host` parameter is required — it does NOT come from `list_printers` (which only returns printer name, status, and queue depth, not the network address). Sources of `host`, in order of preference:
1. If the user already mentioned the IP in their goal, use that.
2. Otherwise ask the user for it — suggest they print a configuration page from the printer's control panel, or check their router's DHCP client list.
3. Skip this step entirely for USB-connected printers (see Edge Cases — `check_printer_connectivity` tests network ports only and will report all-unreachable for USB).

This tests ports 9100 (raw printing), 631 (IPP), and 80 (HTTP admin interface). If all ports are unreachable:
- The printer is powered off, sleeping, or has a different IP than configured
- Ask the user to verify power and to check the printer's IP via its control panel

If port 631 (IPP) is reachable, the printer is online and the issue is software-side.

**Step 5 — Restart the print service**
Call `restart_cups` with `dryRun: true` to check the current service status. If the print service is stopped or unresponsive, call `restart_cups` with `dryRun: false` to restart it. After restart, call `list_printers` again to confirm printers are visible and their status has updated.

**Step 6 — Test printing**
After clearing the queue and confirming the printer is reachable, ask the user to send a test print job. Monitor the queue with `check_print_queue` to see if the job progresses or gets stuck again.

**Step 7 — Remove and re-add the printer (if still failing)**
If the printer remains in an error state despite a reachable network connection and clean queue, the printer configuration or driver may be corrupt.

**Remove**: call `remove_printer` with `printerName` set to the exact name from Step 1's `list_printers` output, and `dryRun: true`. After the user confirms, call again with `dryRun: false`. The G4 consent gate also fires automatically (`requiresConsent: true`, `riskLevel: high`).

**Re-add**: immediately call `add_printer` with:
- `name` (required) — the new printer name. Reuse the name from the just-removed printer so the user's existing workflows/shortcuts continue to work.
- `host` (required) — the printer's IP address from Step 4 (or ask the user if not already captured).
- `protocol` (optional) — defaults to `"ipp"`, which is what you want for IPP Everywhere (the modern auto-driver). Only override to `"lpd"` or `"socket"` if the printer explicitly requires a legacy protocol.
- `driverPpd` (optional) — omit this to let IPP Everywhere auto-negotiate the driver. Supply a PPD path only if the user has a specific manufacturer driver they need to use.

`add_printer` does not support dry-run (`supportsDryRun: false`), but the G4 consent gate fires automatically before it runs.

**Step 8 — Reset entire printing system (last resort)**
If multiple printers are broken or the CUPS/Spooler service is fundamentally corrupted, call `reset_printing_system` with `dryRun: true` to show all printers that would be removed. Warn the user clearly: all printer configurations will be deleted and must be re-added manually. The G4 consent gate fires automatically (`requiresConsent: true`, `destructive: true`, `riskLevel: high`, `affectedScope: ["system"]`) before any changes are made. Only proceed with `dryRun: false` after explicit confirmation.

After reset, re-add the affected printer using `add_printer` with both `name` (chosen by the user or reused from the removed printer) and `host` (the printer's IP — ask the user if not already captured) as required parameters. `protocol` defaults to `"ipp"`, which is correct for IPP Everywhere on most network printers.

**Step 9 — Final verification**
After any repair, ask the user to send a real print job and confirm it completes successfully. Call `check_print_queue` one final time to confirm the job processed and the queue is empty. Report a summary of all steps taken.

---

## Graceful degradation when corrective steps deny

Steps 3 (`clear_print_queue`), 5 (`restart_cups`), 7 (`remove_printer` + `add_printer`), and 8 (`reset_printing_system`) require administrator privileges. For non-admin users the G4 scope check returns `outcome: "denied"` and the corrective step does not run — but this does **not** abort the workflow. Continue diagnostic steps; the diagnosis itself is the deliverable.

When a corrective step denies due to insufficient privileges, in the response:

1. **Do not present the denied step as a failure.** State plainly that the step requires admin privileges and the agent could not run it.
2. **Provide a self-service path the user can follow themselves.** Examples:
   - Clear stuck jobs (macOS): System Settings → Printers & Scanners → click the printer → "Open Print Queue" → click the stuck job → press the X to cancel. The user can clear their own jobs without admin.
   - Clear stuck jobs (Windows): Settings → Bluetooth & devices → Printers & scanners → click the printer → Open print queue → right-click each stuck job → Cancel.
   - Restart print spooler (macOS): no clean self-service; recommend a laptop restart as the equivalent.
   - Restart print spooler (Windows): user can run `Restart-Service Spooler` only from an elevated PowerShell prompt — recommend they ask IT.
   - Remove and re-add (macOS): System Settings → Printers & Scanners → click printer → press the minus button to remove; click the plus button to re-add by IP.
   - Remove and re-add (Windows): Settings → Bluetooth & devices → Printers & scanners → click printer → Remove; then Add device.
3. **Tell the user the diagnosis is being packaged for IT escalation** — the support ticket created at the end of the run captures the printer list, queue state, and network reachability so a tier-1 helpdesk can pick up exactly where the agent left off.

---

## Edge cases

- **Printer shows online but jobs stuck immediately** — this often means the driver is sending a job format the printer does not understand. When re-adding via `add_printer`, use `protocol: "ipp"` with no custom PPD to use IPP Everywhere — this uses driverless printing with a format guaranteed to be compatible
- **USB printers** — `check_printer_connectivity` tests network ports only. For a USB-connected printer, skip Step 4 entirely. If the USB printer is offline, unplug and replug the USB cable, then call `restart_cups` to force the OS to re-detect it
- **Shared network printer via another computer** — if the printer is shared from another computer (not a direct network printer), that computer must be on and the sharing must be enabled. `check_printer_connectivity` will show the host computer's IP as reachable but the printer port may still fail if sharing is disabled
- **CUPS requires sudo** — `restart_cups` and `reset_printing_system` on macOS require elevated privileges. If the agent cannot obtain sudo access, guide the user to open Terminal and run `sudo launchctl stop org.cups.cupsd && sudo launchctl start org.cups.cupsd` manually
- **Printer IP address changes** — DHCP-assigned printer IPs can change after a router reboot. If the printer was working before and is now offline, the IP may have changed. Ask the user to print a configuration page directly from the printer's control panel to find its current IP, then remove and re-add with the new IP
- **Windows Spooler corruption** — on Windows, if `restart_cups` (Spooler restart) does not resolve stuck jobs, the spooler spool files themselves may be corrupt. Guide the user to: stop the Spooler service, delete files in C:\Windows\System32\spool\PRINTERS, restart the Spooler. This is equivalent to `reset_printing_system` on Windows
- **Enterprise print servers** — on corporate networks, printers may be managed via a Windows print server. In this case, `add_printer` should point to the print server's shared printer path (\\printserver\printername) rather than the printer's IP directly. If the print server itself is down, no device-side repair will help — escalate to IT
- **macOS Sequoia and later** — Apple has progressively restricted CUPS access. Some `restart_cups` operations may require the user to manually approve in System Settings → Privacy & Security if the agent does not have Full Disk Access
