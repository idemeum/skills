---
name: process-manager
description: Diagnoses and resolves system performance issues caused by runaway processes, memory pressure, thermal throttling, or excessive startup items. Use when user reports high CPU/memory usage, a frozen application, or slow boot times.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - get_top_consumers
  - get_memory_pressure
  - get_cpu_temperature
  - get_startup_items
  - present_preview
  - restart_process
  - kill_process
  - disable_startup_item
  - get_disk_usage
metadata:
  prerequisites:
    before-corrective:
      - get_top_consumers
      - get_memory_pressure
      - get_cpu_temperature
  maxAggregateRisk: medium
  userLabel: "Computer running slow or app frozen"
    # Examples anchor on a process/CPU/memory/boot cause, NOT bare "slow" (collides
    # with disk-cleanup) and NOT a bare app crash (collides with software-reinstall).
    # The frozen-app example is TRANSIENT — hung right now, recoverable by kill/
    # restart; a crash-every-launch is software-reinstall, an Outlook crash is email.
  examples:
    - "my computer is slow even with plenty of free disk space"
    - "an app is frozen with a spinning beachball right now"
    - "my Mac's fan is loud and apps are sluggish"
    - "my computer takes forever to boot up"
    - "an application is using too much CPU or memory"
  pill:
    label: Fix Performance
    goal: My computer is running slow or an app is frozen and using too much CPU or memory, please diagnose and fix it
    icon: Activity
    iconClass: text-red-500
    order: 5
---

## When to use

Use this skill when the user:
- Reports their computer is running hot, slow, or the fan is loud
- Describes a frozen, spinning-beachball, or unresponsive application
- Asks "what is using my CPU?", "why is my memory full?", or "can you kill that process?"
- Reports slow boot times or too many apps launching at startup

Do NOT use this skill for disk space issues — use the `disk-cleanup` skill instead.

---

## Steps

**Step 1 — Capture top resource consumers**
Call `get_top_consumers` with `metric: "combined"` and `limit: 10`. `memoryHuman` is pre-formatted in binary units (matches Activity Monitor / Task Manager); substitute it verbatim in card rows, never recompute from `memoryMb`. (The agent's own and system processes are already excluded by the tool.)

**Step 2 — Check memory pressure**
Call `get_memory_pressure`. `pressureLevel` is `"normal"` | `"warn"` | `"critical"` — `"warn"`/`"critical"` means the system is swapping, so even low-CPU processes feel sluggish. The RAM figures (`totalRamHuman` / `usedRamHuman` / `swapUsedHuman`) are pre-formatted in binary units (Activity Monitor / Task Manager); substitute verbatim, never recompute.

**Step 3 — Check CPU temperature**
Call `get_cpu_temperature`. Returns `output.cpuTempC` (number or null) and `output.isThrottling` (boolean or null). Throttling kicks in above 90°C — no amount of process-killing fixes a thermal problem.

**Step 4 — List startup items**
Call `get_startup_items` (Apple system agents and the agent's own autostart are excluded by the tool). Always run this step — Step 5's card needs it for the "Disable startup items" category; if there are no *disableable* items the category is simply dropped from the card.

**Step 5 — Present consolidated findings + offer actions**

Call `present_preview` with the card below. **The category list is fixed across every run.** Because the step declares `cardFromClassifier`, G4's gate builds the summary + category rows in code from the Step 1–4 tool outputs (see Data lineage); the `{placeholder}` values in the template are the **fallback contract**, used only if the classifier can't run. Do NOT add per-process category rows.

```yaml
cardFromClassifier: "process-performance"
title: "Performance findings"
summary: "{diagnosticSummary}"
categories:
  - id: restart-helpers
    label: "Restart GUI helpers and apps"
    summary: "{N1} process(es): {list1}"
    defaultSelected: false

  - id: kill-runaway-cpu
    label: "Force-quit CPU-heavy processes"
    summary: "{N2} process(es) over 20% CPU: {list2}"
    destructive: true
    defaultSelected: false

  - id: kill-runaway-memory
    label: "Force-quit memory-heavy processes"
    summary: "{N3} process(es) over 500 MB RAM: {list3}"
    destructive: true
    defaultSelected: false

  - id: disable-startup
    label: "Disable non-Apple startup items"
    summary: "{N4} login item(s): {list4}"
    defaultSelected: false
```

**The card is built in code (`cardFromClassifier: "process-performance"`)** — the classifier is the source of truth. G4's gate computes the summary and category rows from the real Step 1–4 outputs, so they are exact: the agent's own process and system processes are excluded by `get_top_consumers` (system ones appear only in the summary note, never as an action), empty categories are dropped, and if none survive the card is skipped entirely.

The classification logic (system/self exclusion, the restart-vs-kill rules, the disableable-startup filter) lives in the **code classifier** — the single source of truth — so it is not restated here. The `{placeholder}` template is only a display fallback if the classifier can't run (e.g. `get_top_consumers` produced no data); in that case there is nothing to classify, so Step 6 runs **no** correctives.

Returns `{ selected, selectedTargets }` — `selectedTargets` maps each selected category id to its exact code-computed items (`{ pid, name }` / `{ name }`). Empty selection = Step 6 no-ops; Step 7 skips re-running diagnostics.

**Step 6 — Execute confirmed actions**

Step 5 returns `output.selectedTargets` — a map of each selected category id → the **exact items the classifier assigned** to it (`{ pid, name }` for processes, `{ name }` for startup items). **Act on these directly — do NOT re-derive the list.** This guarantees the executed set equals what the user saw and consented to. If `selectedTargets` is absent (the classifier couldn't run), do NOT guess targets — skip the correctives and surface the diagnostics for the user / IT.

For each selected category id, act on `output.selectedTargets[id]`:
- `"restart-helpers"` → `restart_process` with `{ pid, name }` per target. **MUST pass `name`** — without it the tool kills the process but cannot relaunch. The tool `kill -TERM`s the PID, waits 1.5s, then `open -a "<name>"`. Consent gate fires before each (no dry-run support).
- `"kill-runaway-cpu"` and `"kill-runaway-memory"` → `kill_process` with `{ pid, signal: "TERM" }` per target. Do NOT pass `dryRun` — G4 substitutes it. (Dedupe a pid that appears in both before the second kill.)
- `"disable-startup"` → call `disable_startup_item` **once** with `{ names: [<every `name` in `selectedTargets["disable-startup"]`>] }` — **batched, never one call per item**. Do NOT pass `dryRun`. G4 fires a single dry-run preview (listing all items) + a single consent for the whole set.

Each corrective step sets `inputsFrom: [{ step: <step-5-index>, field: "selectedTargets" }]` and a `Condition:` clause testing whether its category id is a key in `selectedTargets`. Skip silently otherwise. If a target terminated between Step 1 and Step 6 (the user lingered at the gate), the tool returns "no matching processes found" — treat as a no-op and continue.

**Did `TERM` actually work?** `kill_process`'s `killed: true` only means the signal was *sent* — it does not confirm termination. The real survival check is Step 7's re-snapshot: if a killed PID still appears in `get_top_consumers`, tell the user it survived and that re-running the skill will escalate to `signal: "KILL"`.

**Step 7 — Verify recovery**
Call `get_top_consumers` again with the same args as Step 1. If Step 2 reported `"warn"` or `"critical"` pressure, also call `get_memory_pressure` again. Skip both calls when Step 5's `selected` was empty AND no diagnostic concerns were flagged in Step 5's summary.

**Step 8 — Check disk pressure (slowness is often disk-related)**
Call `get_disk_usage`. If `output.usagePercent >= 85`, the root volume is nearly full — which causes swapping and sluggishness that killing processes won't resolve. Surface it and offer to run the `disk-cleanup` skill to reclaim space. When `usagePercent < 85`, make no disk recommendation.

**Step 9 — Final report**
One short paragraph: which processes were acted on, what the post-action snapshot looks like, and any remaining concerns. If memory pressure or CPU temperature stayed elevated and no user-scope process was the cause, advise a system restart or escalating to IT with the Step 1–3 diagnostic snapshot. If Step 8 found high disk usage, mention the `disk-cleanup` option.

---

## Edge cases

- **System-scope processes cannot be killed from here** — `kernel_task`, `WindowServer`, `launchd`, `loginwindow`, `coreaudiod`, `mds`, anything in `/System/`, and any process the current user does not own. macOS rejects the kill with EPERM regardless of how the agent invokes it. Always surface these via the `{systemProcessNote}` in Step 5's summary, never as a category. Advise restart or IT escalation.
- **Auto-restarting children and daemons are killed, not restarted** — Electron Helpers, Chrome Helpers, launchd daemons, Windows services all auto-respawn within seconds of being killed because their parent app or service manager brings them back. These go in `kill-runaway-cpu` / `kill-runaway-memory`, NOT `restart-helpers`. The kill IS the restart from the user's perspective.
- **Browser at the top** — top-level browsers (`Google Chrome`, `Safari`, `Firefox`, `Microsoft Edge`) ARE eligible for `restart-helpers` because they're launchable .app bundles. Mention closing tabs / disabling extensions in chat. Note: browser Helper / Renderer child processes (`Google Chrome Helper (Renderer)`) are NOT eligible — they go to kill categories where Chrome's parent process respawns them.
- **Antivirus / backup scans** — high CPU from `MsMpEng.exe` (Windows Defender), `mds_stores` (Spotlight indexing), or Time Machine is expected during scheduled scans. Surface in chat as "expected, will subside" rather than as an actionable row.
- **Thermal throttling overrides everything** — when `output.isThrottling` is true, the `{diagnosticSummary}` should lead with the throttling message. Killing processes will not fix a thermal problem; advise checking vents, hard surface, and letting the machine cool down.
- **TERM vs KILL** — Step 6 always sends `TERM`. Escalation to `KILL` requires a second user-triggered run; do not auto-escalate within a single run.
- **No elevated permissions** — `get_top_consumers` only sees processes the current user can observe. Root-owned processes may show 0% CPU even when active; the snapshot is incomplete, not wrong.
