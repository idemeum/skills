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
  - request_user_input
  - wait_for_user_ack
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
    order: 4
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

This skill follows a **diagnostic-driven escalation** pattern. The agent runs all read-only diagnostics first, then escalates corrective actions from lightest (clear queue) to most destructive (reset entire printing system) — only invoking a corrective step when prior diagnostic output proves the lighter fix wouldn't help. G4's per-tool consent gate fires before every destructive action; the user can abort mid-escalation.

---

## Steps

**Step 1 — Inventory configured printers**
Call `list_printers`. Returns `output.printers: [{ name, status, queueDepth }]` (statuses on macOS: `idle`, `stopped`, `processing`, `disabled`) and `output.defaultPrinter`. Used by every downstream step to identify printers and their states.

**Step 2 — Check ALL print queues**
Call `check_print_queue` with **no `printerName` arg**. Returns `output.jobs: [{ id, printer, owner, document, status, sizeKb, sizeHuman, submittedAt }]`, `output.stuckCount`, `output.total`. The unfiltered call returns jobs for every configured printer in one pass — avoids the "which printer is affected?" ambiguity and gives the executor full queue state to drive escalation decisions. `sizeHuman` is pre-formatted (decimal/SI MB to match Finder / Explorer); substitute verbatim, do NOT recompute from `sizeKb`.

**Step 3 — Capture the target printer's IP address**
Call `request_user_input` to obtain the network printer's IP address or hostname. `check_printer_connectivity` requires `host` and `list_printers` does NOT return network addresses — the IP is only knowable from the printer's control panel, the user's router DHCP table, or the user's prior knowledge.

```yaml
prompt: "What's the IP address or hostname of the printer that's not working? You can find it by printing a configuration page from the printer's control panel, or by checking your router's connected-devices list."
placeholder: "192.168.1.50 or printer.local"
validator: "^[A-Za-z0-9.\\-:]+$"
```

`Condition:` only run if (a) Step 1's `list_printers` returned at least one printer in `stopped` / `disabled` state OR the user's goal names a specific printer, AND (b) the user's goal does NOT already contain an IP/hostname (the planner can use the goal-provided value directly without invoking this step), AND (c) the target printer is network-attached (USB printers — see Edge Cases — skip this step entirely because `check_printer_connectivity` only tests network ports). Skip silently otherwise — Step 4 will also skip when no host is known.

If the user submits an empty value (cancel / timeout), Step 4 will skip and the escalation continues without network reachability evidence. Surface that gap in the final summary.

**Step 4 — Check network connectivity for the printer the user cares about**
Call `check_printer_connectivity` with `host` set to the captured IP/hostname.

`inputsFrom: [{ step: 3, field: "value" }]` — pass the Step 3 capture as `host`. If the user's goal already contained an IP and Step 3 was skipped, pass that goal-provided value directly.

`Condition:` only run if a valid `host` value is available (either from Step 3's non-empty return or from the user's goal). Skip silently otherwise.

The tool tests ports 9100 (raw printing), 631 (IPP), and 80 (HTTP admin interface). If all ports are unreachable, the printer is powered off, sleeping, or has a different IP than configured. If port 631 (IPP) is reachable, the printer is online and the issue is software-side.

**Step 5 — Clear stuck print jobs (lightest corrective)**
**Condition:** only if `check_print_queue` in Step 2 returned `output.stuckCount > 0` OR `output.total > 0` AND the user explicitly asked to clear the queue.

Call `clear_print_queue`. G4's binding dry-run preview + consent gate fires automatically — the user sees which jobs would be cancelled before any destructive action.

**Step 6 — Verify the queue cleared**
**Condition:** only if Step 5 ran.

Call `check_print_queue` (no args) again. If `output.stuckCount` is now 0 and `output.total` is 0, the queue clear succeeded and the user can test printing — stop the escalation here unless the printer still won't print. If jobs remain or new ones are stuck immediately, the issue is service-side or driver-side; continue to Step 7.

**Step 7 — Restart the print service (CUPS / Spooler)**
**Condition:** only if Step 1 returned at least one printer with status `stopped` or `disabled`, OR Step 6 showed jobs persisting after a queue clear. Skip when Step 1 shows all printers `idle` AND Step 6 confirmed the queue is empty.

Call `restart_cups`. G4's binding dry-run preview + consent gate fires automatically. After the restart, call `list_printers` again to confirm printers are visible and their status has updated (this is handled by the next plan step's conditional re-check, not by repeating tools inside this step).

**Step 8 — Re-check printer status after CUPS restart**
**Condition:** only if Step 7 ran.

Call `list_printers` again. If the previously-stopped printer is now `idle`, the restart resolved the service issue — stop escalating. If the printer remains `stopped` / `disabled` AND Step 4 confirmed the host is reachable on port 631, the printer's configuration or driver is likely corrupt; continue to Step 9.

**Step 9 — Remove and re-add the printer (driver / config likely corrupt)**
**Condition:** only if (a) Step 8 showed the printer still in `stopped` / `disabled` state after CUPS restart AND (b) Step 4 confirmed port 631 (IPP) reachable, OR the user explicitly asked to re-add the printer.

Call `remove_printer` with `printerName` set to the exact name from Step 1's `list_printers` output. G4's binding dry-run + consent gate fires automatically.

Then immediately call `add_printer` with:
- `name` (required) — reuse the name from the just-removed printer so the user's existing workflows / shortcuts continue to work.
- `host` (required) — the printer's IP address captured in Step 3 (`inputsFrom: [{ step: 3, field: "value" }]`). If Step 3 was skipped because the goal supplied the value directly, reuse that goal-provided value. Do NOT chat-narrate "ask the user" — Step 3 is the authoritative capture point.
- `protocol` (optional) — defaults to `"ipp"`, which is correct for IPP Everywhere (the modern auto-driver). Only override to `"lpd"` or `"socket"` if the printer explicitly requires a legacy protocol.
- `driverPpd` (optional) — omit this to let IPP Everywhere auto-negotiate the driver. Supply a PPD path only if the user has a specific manufacturer driver they need to use. `~` in the path is expanded to the user's home directory.

`add_printer` does not support dry-run (`supportsDryRun: false`); G4's consent gate fires automatically before it runs.

**Step 10 — Reset entire printing system (last resort)**
**Condition:** only if (a) `list_printers` returned multiple printers all in `stopped` / `disabled` state AND prior corrective steps either failed or are inapplicable (no single printer to remove + re-add), OR (b) the user explicitly asked to reset everything.

Call `reset_printing_system`. G4's binding dry-run + consent gate fires automatically — the dry-run preview lists every printer that will be removed, and consent requires explicit user approval. Warn the user clearly in the surrounding chat that all printer configurations will be deleted and must be re-added manually.

**After the reset succeeds**, re-add each affected printer. For each printer in Step 1's `list_printers.printers[]` snapshot (captured before the reset wiped configurations), call `request_user_input` to capture that printer's IP, then call `add_printer`. Drive this as a `forEach` loop:

`forEach: { source: "step-1.printers" }` — iterate one entry per printer.

Per-iteration calls:
1. Call `request_user_input` with prompt: *"What's the IP address or hostname for printer {printerName}? Leave blank to skip re-adding this one."* `placeholder: "192.168.1.50"`, `validator: "^[A-Za-z0-9.\\-:]*$"` (note `*` not `+` — empty value is a valid skip signal). `inputsFrom: [{ step: 1, field: "printers" }]` for the iteration source.
2. If the user submitted a non-empty value, call `add_printer` with `name: <printer.name>`, `host: <captured value>`, `protocol: "ipp"`. If the user submitted empty, skip this printer and continue the loop.

Surface a summary of which printers were re-added and which were skipped in the Step 11 final report.

**Step 11 — Final verification**
**Condition:** only if any corrective step (5, 7, 9, or 10) ran.

Call `check_print_queue` (no args) one final time. If `output.stuckCount` is 0 and `output.total` is 0, the diagnostic loop is complete. Report a summary in chat of which corrective steps ran and the final state.

Then call `wait_for_user_ack` to wait for the user to actually test printing — the agent cannot observe a successful print job from the OS-side queue alone:

```yaml
prompt: "Send a real print job from any app to the printer that was broken. Let me know whether it printed successfully."
options:
  - { id: "worked",       label: "It printed",                kind: "primary" }
  - { id: "still-broken", label: "Still not printing",        kind: "secondary" }
  - { id: "skip",         label: "Skip — I'll test later",    kind: "cancel" }
```

On `worked`: report success and end the run. On `still-broken`: surface that all in-scope correctives have run without resolving the issue; escalate to IT with the diagnostic packet. On `skip`: close the run with "diagnostics complete; user will verify later".

---

## Privilege handling — helper-routed (default) vs. fallback

Steps 5, 7, 9, and 10 require administrator privileges to execute the underlying OS commands. The agent handles this transparently in two modes:

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): the agent routes these steps through the helper daemon and they complete silently for **all users — admin and non-admin alike**. The user sees the step succeed end-to-end. No "this requires admin" messaging is needed in the response.

**When the helper is unavailable** (`HELPER_DAEMON_ENABLED=false`, helper not installed, or helper unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`): the corrective step denies and the diagnostic continues to completion — the diagnosis is still the deliverable. In this fallback case, in the response:

1. **Do not present the denied step as a failure.** State plainly that the agent couldn't complete the privileged step on this device and explain why (helper unavailable / not enabled / non-admin user).
2. **Provide a self-service path the user can follow themselves.** Examples:
   - Clear stuck jobs (macOS): System Settings → Printers & Scanners → click the printer → "Open Print Queue" → click the stuck job → press the X to cancel. The user can clear their own jobs without admin.
   - Clear stuck jobs (Windows): Settings → Bluetooth & devices → Printers & scanners → click the printer → Open print queue → right-click each stuck job → Cancel.
   - Restart print spooler (macOS): no clean self-service; recommend a laptop restart as the equivalent.
   - Restart print spooler (Windows): user can run `Restart-Service Spooler` only from an elevated PowerShell prompt — recommend they ask IT.
   - Remove and re-add (macOS): System Settings → Printers & Scanners → click printer → press the minus button to remove; click the plus button to re-add by IP.
   - Remove and re-add (Windows): Settings → Bluetooth & devices → Printers & scanners → click printer → Remove; then Add device.
3. **Tell the user the diagnosis is being packaged for IT escalation** — the support ticket captures the printer list, queue state, and network reachability so a tier-1 helpdesk can pick up exactly where the agent left off. IT can also investigate why the helper is unavailable on this device.

---

## Edge cases

- **Printer shows online but jobs stuck immediately** — this often means the driver is sending a job format the printer does not understand. When re-adding via `add_printer`, use `protocol: "ipp"` with no custom PPD to use IPP Everywhere — this uses driverless printing with a format guaranteed to be compatible
- **USB printers** — `check_printer_connectivity` tests network ports only. For a USB-connected printer, skip Steps 3 and 4 entirely (Step 3's `request_user_input` is conditioned on network-attached printers; Step 4's connectivity check needs a network host). If the USB printer is offline, unplug and replug the USB cable, then call `restart_cups` to force the OS to re-detect it
- **Shared network printer via another computer** — if the printer is shared from another computer (not a direct network printer), that computer must be on and the sharing must be enabled. `check_printer_connectivity` will show the host computer's IP as reachable but the printer port may still fail if sharing is disabled
- **CUPS requires elevated privileges** — `restart_cups` and `reset_printing_system` on macOS need root to talk to `launchctl system/...`. With the privileged helper daemon installed (default), this is handled silently end-to-end. If the helper is unavailable or disabled, guide the user to open Terminal and run `sudo launchctl kickstart -k system/org.cups.cupsd` manually as the fallback.
- **Printer IP address changes** — DHCP-assigned printer IPs can change after a router reboot. If the printer was working before and is now offline, the IP may have changed. Ask the user to print a configuration page directly from the printer's control panel to find its current IP, then remove and re-add with the new IP
- **Windows Spooler corruption** — on Windows, if `restart_cups` (Spooler restart) does not resolve stuck jobs, the spooler spool files themselves may be corrupt. Guide the user to: stop the Spooler service, delete files in `C:\Windows\System32\spool\PRINTERS`, restart the Spooler. This is equivalent to `reset_printing_system` on Windows
- **Enterprise print servers** — on corporate networks, printers may be managed via a Windows print server. In this case, `add_printer` should point to the print server's shared printer path (`\\printserver\printername`) rather than the printer's IP directly. If the print server itself is down, no device-side repair will help — escalate to IT
- **macOS Sequoia and later** — Apple has progressively restricted CUPS access. Some `restart_cups` operations may require the user to manually approve in System Settings → Privacy & Security if the agent does not have Full Disk Access
