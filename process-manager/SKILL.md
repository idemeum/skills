---
name: process-manager
description: Diagnoses and resolves system performance issues caused by runaway processes, memory pressure, thermal throttling, or excessive startup items. Use when user reports high CPU/memory usage, a frozen application, or slow boot times.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - get_top_consumers
  - get_memory_pressure
  - get_cpu_temperature
  - restart_process
  - kill_process
  - get_startup_items
  - disable_startup_item
  - get_processes
metadata:
  prerequisites:
    before-corrective:
      - get_top_consumers
      - get_memory_pressure
      - get_cpu_temperature
  maxAggregateRisk: medium
  userLabel: "Computer running slow or app frozen"
  examples:
    - "my computer is very slow"
    - "an app is frozen and not responding"
    - "my Mac is sluggish and unresponsive"
    - "everything is running slowly today"
    - "an application is using too much CPU or memory"
  pill:
    label: Fix Performance
    goal: My Mac is running slow or an app is frozen and using too much CPU or memory, please diagnose and fix it
    icon: Activity
    iconClass: text-red-500
    order: 6
---

## When to use

Use this skill when the user:
- Reports their computer is running hot, slow, or the fan is loud
- Describes a frozen, spinning-beachball, or unresponsive application
- Asks "what is using my CPU?", "why is my memory full?", or "can you kill that process?"
- Wants to identify which background applications are consuming resources
- Reports slow boot times or too many apps launching at startup
- Suspects thermal throttling is degrading performance

Do NOT use this skill for disk space issues — use the `disk-cleanup` skill instead.

---

## Steps

**Step 1 — Capture performance snapshot**
Call `get_top_consumers` with `metric: "combined"` and `limit: 10` for an immediate ranked view of the worst offenders across both CPU and memory.

**Step 2 — Check memory pressure**
Call `get_memory_pressure` to get the overall RAM pressure level, swap usage, and page fault rate. A pressure level of "warn" or "critical" means the system is actively swapping — even low-CPU processes will cause sluggishness.

**Step 3 — Check CPU temperature**
Call `get_cpu_temperature` to detect thermal throttling. If CPU temp is above 90°C the processor is throttling its own speed — no amount of process-killing will fix this until it cools down.

**Step 4 — Present findings**
Display a combined picture: top processes (name, PID, CPU%, memory MB), memory pressure level, swap used, and CPU temperature. Flag:
- Any process over 20% CPU as high-priority
- Any process over 500 MB RAM as high-memory
- Memory pressure "warn" or "critical" as a system-wide concern
- CPU temp above 85°C as a thermal concern

> **Note on Windows CPU column:** On Windows the `cpu` field shows cumulative CPU time in seconds, not a live percentage. Compare processes relative to each other rather than against a fixed threshold.

**Step 5 — Identify the culprit**
Match high-resource process names to known applications. Explain what each likely does (e.g. "kernel_task is macOS managing thermals", "node is a Node.js server"). Help the user decide if it is expected or a runaway process.

**Step 6 — Advise on action**
Based on the identified process, recommend one of:
- **Wait** — the process is doing legitimate work (indexing, update, backup); advise how long it typically takes
- **Restart gracefully** — call `restart_process` with the process `name` (or `pid`). Include `launchPath` if the process does not relaunch itself. This tool does not support dry-run — the G4 consent gate will prompt the user for confirmation before execution. Use for hung-but-restartable processes (Finder, security agent, VPN client)
- **Kill** — call `kill_process` with `dryRun: true` first, confirm with user, then `dryRun: false` with `signal: "TERM"`. Escalate to `signal: "KILL"` only if TERM fails

If the identified culprit is a system process (`kernel_task`, root-owned daemon, anything in `/System/`, or any process the current user does not own), the user cannot kill it without admin — the OS will reject the attempt with EPERM regardless of how the agent invokes it. In that case, advise either a laptop restart (clears the offender for now) or escalate to IT with the diagnostic snapshot from Steps 1–4.

**Step 7 — Kill or restart (with confirmation)**
For `kill_process`, always call with `dryRun: true` first to show which processes would be affected, then confirm with the user before calling with `dryRun: false`. For `restart_process`, the G4 consent gate handles user confirmation automatically (the tool does not support dry-run). Never kill protected system processes (see Edge Cases).

**Step 8 — Verify recovery**
Call `get_top_consumers` again after termination to confirm usage has dropped. Call `get_memory_pressure` again if memory pressure was elevated.

**Step 9 — Check startup items (if slow boot reported)**
If the user reports slow startup or too many things launching at login:
- Call `get_startup_items` to list all login items, launch agents, and launch daemons
- Present the list, flagging any non-Apple items the user may not recognise
- For items the user wants to remove, call `disable_startup_item` with `dryRun: true` first, confirm, then `dryRun: false`

**Step 10 — Final report**
Summarise: which process was the issue, what action was taken, and the before/after resource metrics. If the problem persists, suggest a system restart or escalate to a deeper diagnostic (disk cleanup, security agent check).

---

## Edge cases

- **Never kill protected system processes** — `kill_process` blocks these, but do not attempt to work around the block:
  - macOS: **kernel_task**, **WindowServer**, **launchd**, **loginwindow**, **coreaudiod**, **mds**
  - Windows: **System**, **smss.exe**, **csrss.exe**, **wininit.exe**, **lsass.exe**, **svchost.exe**, **explorer.exe**
- **Auto-restarting processes** — launchd daemons and Windows services restart within seconds of being killed; use `restart_process` instead, or advise the user the process will reappear
- **Browser tabs** — if a browser appears at the top, suggest closing unused tabs or disabling extensions before force-quitting the whole browser (all tabs would be lost)
- **Antivirus / backup scans** — high CPU from `MsMpEng.exe` (Windows Defender) or Time Machine is expected during scheduled scans; advise the user to wait
- **Thermal throttling** — if `get_cpu_temperature` shows >90°C, killing processes alone will not fix it; advise the user to check for blocked vents, use on a hard surface, and allow the machine to cool before further diagnosis
- **Missing process** — if the user names a process not in the top results, call `get_processes` with `limit: 100` and `sortBy: "name"` to find it
- **TERM vs KILL** — always try `signal: "TERM"` first; TERM allows the process to save state and clean up; only escalate to `signal: "KILL"` if TERM has no effect after 10–15 seconds
- **No elevated permissions** — `get_processes` and `get_top_consumers` only see processes the current user owns; kernel and root processes may show 0% CPU even when active
