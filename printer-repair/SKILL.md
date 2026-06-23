---
name: printer-repair
description: Diagnoses and repairs printing issues including stuck print queues, offline printers, and CUPS/Spooler service failures. Clears jammed queues and restarts the print service; guides self-service + IT escalation for driver/config corruption. Use when a printer is not printing, showing as offline, or the print queue is jammed.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - list_printers
  - check_print_queue
  - check_printer_connectivity
  - clear_print_queue
  - restart_cups
  - request_user_input
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - list_printers
      - check_print_queue
  maxAggregateRisk: medium
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
- Sends a print job but nothing comes out
- Reports the printer shows as "Offline" or "Error"
- Has jobs stuck in the queue that won't cancel normally
- Reports printing broke after a macOS/Windows update
- Asks "why won't my printer work?" / "my print queue is stuck"

Do NOT use it for hardware faults (printer power light off, panel error) — those need physical intervention, not software repair.

**Pattern — diagnostic-driven escalation.** Run the read-only diagnostics first, then the lightest corrective the evidence supports. The two correctives (clear queue, restart print service) need admin and run through the privileged helper daemon; when the helper is unavailable they deny gracefully and the skill falls back to **self-service guidance + IT escalation** (see Privilege handling). Deeper fixes — remove/re-add a printer, reset the whole printing system — are **not** agent-executed here: they're admin-gated, high-blast-radius, and error-prone, so they're offered as guided self-service instead.

---

## Steps

**Step 1 — Inventory printers**
Call `list_printers`. `status` is canonical: `idle | processing | stopped | disabled | offline | error | unknown` — treat `unknown` as "state undetermined; do NOT assume healthy". `type` is canonical: `network | local | virtual`. `host` is the printer's IP/hostname when derivable (network printers); `null` for USB/virtual printers and for Bonjour printers whose host isn't literal in the device URI. (`offline`/`error` surface on Windows; macOS reports an unreachable/paused printer as `stopped`/`disabled`.)

**Step 2 — Check all print queues**
Call `check_print_queue` with **no `printerName`**. `stuckCount` counts jobs in error/paused/`held` state (`held` = queued behind a stopped/disabled printer); `total` is all jobs. Substitute `sizeHuman` verbatim; do NOT recompute from `sizeKb`.

**Step 3 — Get the printer's host (fallback only)**
**Condition:** only if the target network printer's `host` is `null` in Step 1 (Bonjour / undetectable) AND the goal doesn't already contain an IP/hostname AND the target's `type === "network"`. If Step 1 already surfaced `output.printers[].host` for the target, use it directly and skip this prompt. Skip entirely for `local` / `virtual` printers (no network host).

```yaml
prompt: "What's the IP address or hostname of the printer that's not working? Find it on the printer's control panel (print a config page) or in your router's device list."
placeholder: "192.168.1.50 or printer.local"
validator: "^[A-Za-z0-9.\\-:]+$"
```

Empty value (cancel/timeout) → Step 4 skips; note the missing reachability evidence in the summary.

**Step 4 — Check network reachability**
Call `check_printer_connectivity` with `host` = the target's `host` from Step 1 if present, else the Step 3 capture (`inputsFrom: [{ step: 3, field: "value" }]`), else a goal-provided value.
**Condition:** only if a `host` is available. Skip silently otherwise.
It tests ports 9100 (raw), 631 (IPP), 80 (admin). `output.isReachable` is true when **any** of those ports answers. If `output.isReachable` is false (all ports unreachable), the printer is off/asleep or on a different IP — a connectivity problem. If `output.isReachable` is true, the printer is online (reachable on the network) and the issue is software/config-side. (For an IPP-specific check, read the port-631 entry in `output.ports`.)

**Step 5 — Clear stuck jobs (lightest corrective)**
**Condition:** only if Step 2 returned `output.stuckCount > 0` (jobs that won't progress — held/error/paused). A queue with only healthy in-progress jobs (`stuckCount` 0) is not cleared.
Call `clear_print_queue` — **do NOT pass `dryRun`**. The dry-run preview + consent gate is applied automatically (the user sees which jobs would be cancelled before any are). Admin-gated → runs via the helper daemon; if the helper is unavailable, see Privilege handling for the self-service queue-clear.

**Step 6 — Verify the queue cleared**
**Condition:** only if Step 5 ran.
Call `check_print_queue` (no args). If `output.total === 0` the queue is empty — but whether printing actually *works* is only knowable from the user, so do NOT declare success here; the Step 9 test-print ack is the real verification. If jobs persist or immediately re-stick, the cause is service- or driver-side — continue to Step 7.

**Step 7 — Restart the print service (CUPS / Spooler)**
**Condition:** only if Step 1 returned a printer with `status` `stopped` / `disabled` / `offline` / `error`, OR Step 6 showed jobs persisting after a clear. Skip when all printers are `idle` and the queue is empty.
Call `restart_cups` — **do NOT pass `dryRun`**. The dry-run preview + consent gate is applied automatically. Admin-gated → helper daemon; fallback in Privilege handling.

**Step 8 — Re-check after restart**
**Condition:** only if Step 7 ran.
Call `list_printers` again. If the printer is now `idle`, the restart resolved it. If it's still `stopped` / `disabled` / `offline` AND (Step 4 reported `output.isReachable` true, or the host is unknown), the printer's configuration or driver is likely corrupt — beyond user-space repair. Direct the user to the self-service **remove + re-add** steps in Privilege handling and package the diagnostics for IT. (This skill does not remove/re-add printers itself.)

**Step 9 — Final verification (test print)**
**Condition:** only if a corrective ran (Step 5 or Step 7).
Call `wait_for_user_ack` — the agent cannot observe a successful print from the OS queue alone:

```yaml
prompt: "Send a real print job from any app to the printer that was broken. Did it print?"
options:
  - { id: "worked",       label: "It printed",          kind: "primary" }
  - { id: "still-broken", label: "Still not printing",  kind: "secondary" }
  - { id: "skip",         label: "I'll test later",     kind: "cancel" }
```

`worked` → report success and end. `still-broken` → in-scope correctives are exhausted; give the self-service remove/re-add steps and escalate to IT with the diagnostic packet. `skip` → close with "diagnostics complete; user will verify later".

**Step 10 — Final report**
Summarise which diagnostics + correctives ran, the final state, and any self-service / IT-escalation guidance.

---

## Privilege handling — helper-routed (default) vs self-service fallback

The two correctives — `clear_print_queue` (Step 5) and `restart_cups` (Step 7) — need admin and run through the privileged helper daemon, completing silently for admin **and** non-admin users when the helper is installed (`HELPER_DAEMON_ENABLED=true`). No "requires admin" messaging is needed then.

When the helper is unavailable (`HELPER_DAEMON_ENABLED=false`, not installed, or unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`), the corrective denies and the diagnostic still completes (the diagnosis is the deliverable). In that case, in the response:

1. **Don't present the denied step as a failure** — explain the agent couldn't run the privileged action on this device and why.
2. **Give the self-service path:**
   - **Clear stuck jobs** — macOS: System Settings → Printers & Scanners → the printer → Open Print Queue → select the job → ✕. Windows: Settings → Bluetooth & devices → Printers & scanners → the printer → Open print queue → right-click the job → Cancel.
   - **Restart the print service** — macOS: restart the Mac, or run `sudo launchctl kickstart -k system/org.cups.cupsd` in Terminal. Windows (elevated PowerShell): `Restart-Service Spooler`.
   - **Remove + re-add the printer** (when Step 8 indicates corrupt config/driver) — macOS: System Settings → Printers & Scanners → select the printer → ⊖ to remove, then ⊕ to re-add by IP (choose IPP for driverless printing). Windows: Settings → Printers & scanners → the printer → Remove, then Add device (Windows installs the IPP class driver).
   - **Reset the whole printing system** (last resort — wipes ALL printers, re-add each after) — macOS: right-click the printer list in Printers & Scanners → "Reset printing system…". Windows: stop the Spooler, delete `C:\Windows\System32\spool\PRINTERS\*`, start the Spooler.
3. **Package the diagnosis for IT** — the ticket carries the printer list, queue state, and reachability so tier-1 can continue; IT can also investigate why the helper is unavailable on this device.

## Edge cases

- **USB / local printers** — `type: "local"`, `host: null`. `check_printer_connectivity` tests network ports only, so Steps 3–4 skip. If a local printer is offline, unplug/replug the USB cable and run Step 7 (restart service) to force re-detection.
- **Shared network printer (via another computer)** — the host computer must be on with sharing enabled; connectivity may show the host reachable while the print port still fails if sharing is off.
- **Printer IP changed (DHCP)** — a printer that worked then went offline may have a new IP after a router reboot. Print a config page for the current IP, then use the self-service remove + re-add.
- **macOS CUPS restart (Sonoma 14.4+ / Sequoia)** — `restart_cups` needs admin/root (the helper daemon provides it; Full Disk Access is NOT involved). It uses `launchctl kickstart -k system/org.cups.cupsd` — the older `launchctl stop`/`start` no longer restarts protected system daemons on 14.4+. When the helper is unavailable, the self-service path is the same `kickstart` command in Terminal (see Privilege handling).
- **Enterprise print servers** — corporate printers are often shared from a Windows print server (`\\server\printer`); if the server is down, no device-side repair helps — escalate to IT.
