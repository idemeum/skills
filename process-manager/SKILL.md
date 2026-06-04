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
Call `get_top_consumers` with `metric: "combined"` and `limit: 10`. Returns `output.processes: [{ pid, name, cpuPercent, memoryMb, memoryHuman, combinedScore }]`. `memoryHuman` is pre-formatted in binary units (matches Activity Monitor / Task Manager); substitute verbatim in card rows, never recompute from `memoryMb`.

**Step 2 — Check memory pressure**
Call `get_memory_pressure`. Returns `output.pressureLevel` (`"normal"` | `"warn"` | `"critical"`), pre-formatted `output.totalRamHuman`, `output.usedRamHuman`, `output.swapUsedHuman` (binary units — match Activity Monitor / Task Manager; substitute verbatim, never recompute). Pressure `"warn"` or `"critical"` means the system is swapping — even low-CPU processes will feel sluggish.

**Step 3 — Check CPU temperature**
Call `get_cpu_temperature`. Returns `output.cpuTempC` (number or null) and `output.isThrottling` (boolean or null). Throttling kicks in above 90°C — no amount of process-killing fixes a thermal problem.

**Step 4 — List startup items**
Call `get_startup_items`. Returns `output.loginItems: [{ name, path, type }]` (Apple system agents are excluded by default). Always run this step — the consolidated card in Step 5 has a "Disable startup items" category that needs this data; on machines with no non-Apple login items the category still renders with a count of zero.

**Step 5 — Present consolidated findings + offer actions**

Call `present_preview` with the four-category card below. **The category list is fixed across every run** — only the `summary` strings are filled in from prior scratchpad output (same pattern as `disk-cleanup`'s cleanup-plan card). Do NOT add per-process category rows — that pattern's MUST guards do not survive the planner→executor boundary.

```yaml
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

Data lineage (executor LLM substitutes `{placeholder}` tokens at runtime from prior scratchpad outputs):

- top-level `{diagnosticSummary}` — multi-line string built from Steps 2 and 3 outputs, plus a system-process callout when relevant. Newlines render in the card. Format:
  ```
  Memory pressure: {output.pressureLevel from Step 2} ({output.swapUsedHuman from Step 2} swap).
  CPU temperature: {output.cpuTempC from Step 3}°C{ " — thermal throttling detected." if output.isThrottling else "."}
  {systemProcessNote}                              # see below
  ```
  - Substitute `output.swapUsedHuman` verbatim — do NOT divide `swapUsedMb` by 1024 or recompute. The tool already formatted it.
  - When `output.cpuTempC` is null, write `"CPU temperature: unavailable (requires elevated access)."` instead of pretending to know.
  - **MUST: `{systemProcessNote}` is the ONLY place in the entire card where system-scope processes are mentioned.** If any high-resource process (cpuPercent > 20 OR memoryMb > 500) from Step 1's `output.processes` is system-scope (`kernel_task`, `WindowServer`, `launchd`, `loginwindow`, `coreaudiod`, `mds`, root-owned daemons, anything in `/System/`), write a `{systemProcessNote}` line — do NOT omit it, do NOT paraphrase it away, do NOT drop it because the prose-narration "reads better" without it. Format: `"Note: {name} (PID {pid}) is the top CPU consumer at {cpuPercent}% but cannot be acted on here — it is a system process. Restart your Mac or contact IT."` (Or `"top memory consumer at {memoryHuman}"` when memory is the issue.) Omit the line entirely ONLY when no system process exceeds the threshold.

- Process **classification** (computed once, drives all 3 process categories' summaries; PID belongs to at most one category). For each entry in Step 1's `output.processes`:
  - **Skip if system-scope.** System-scope processes (`kernel_task`, `WindowServer`, `launchd`, `loginwindow`, `coreaudiod`, `mds`, root-owned daemons, anything in `/System/`) are NEVER classified into any category — not `restart-helpers`, not `kill-runaway-cpu`, not `kill-runaway-memory`. They are surfaced exclusively in the top `{systemProcessNote}` above.
  - If the name is a **top-level launchable GUI app** AND `cpuPercent > 20`: assign to `restart-helpers`. Top-level launchable apps are processes whose name corresponds to an installed `.app` bundle that responds to `open -a <Name>`. Eligible examples: `Finder`, `Mail`, `Safari`, `Google Chrome`, `Firefox`, `Microsoft Edge`, GUI security clients like `Falcon` / `CrowdStrike` / `Sophos`, GUI VPN clients like `Cisco Secure Client`. The `restart_process` tool will `kill` the process and then `open -a "<name>"` to relaunch it as a fresh top-level app.
  - **NOT eligible for `restart-helpers`:** processes whose names contain `Helper`, `(Renderer)`, `(GPU)`, `agent`, `daemon`, or `xpcservice`, OR names with characters outside `[a-zA-Z0-9 _\-.]` (parens, ampersands, slashes — `restart_process` validation rejects these AND `open -a` cannot find a matching .app bundle for them). These processes are child / helper processes that the parent app or launchd will respawn automatically when killed — so killing them IS the restart. They flow to `kill-runaway-cpu` or `kill-runaway-memory` below, where `kill_process` does exactly the right thing (parent or launchd auto-respawns; user sees the process effectively restart). Examples that always go to a kill category, never restart-helpers: `Electron Helper (GPU)`, `Electron Helper (Renderer)`, `Google Chrome Helper (Renderer)`, `Keybase Helper`, `Slack Helper`, `Microsoft AutoUpdate.Helper`.
  - Else if `cpuPercent > 20`: assign to `kill-runaway-cpu`.
  - Else if `memoryMb > 500`: assign to `kill-runaway-memory`.
  - Else: skip (not actionable).

- inside `restart-helpers.summary`:
  - `{N1}` — count of processes classified as `restart-helpers`
  - `{list1}` — comma-separated `"{name} (PID {pid}, {cpuPercent}% CPU, {memoryHuman})"` for each classified process. `memoryHuman` is from Step 1 and is pre-formatted in binary units (matches Activity Monitor); substitute verbatim, do NOT recompute from `memoryMb`. Cap at 3 names then `", …"` if more.
  - If `{N1}` is 0, write `"0 process(es): none currently running"` and let the user see the empty row (still selectable; Step 6 will no-op for an empty category).

- inside `kill-runaway-cpu.summary`:
  - `{N2}` — count of processes classified as `kill-runaway-cpu`. **MUST: this count NEVER includes system-scope processes** (they are excluded by classification per the rule above). If WindowServer is at 49% CPU and 4 other processes are above 20% CPU, `{N2}` is `4`, not `5`.
  - `{list2}` — same format as `{list1}`. **MUST: this list NEVER includes system-scope process names** — they were already filtered at classification. A user reading this list should be able to trust that every name shown is actionable.

- inside `kill-runaway-memory.summary`:
  - `{N3}` — count of processes classified as `kill-runaway-memory`. Same exclusion rule as `{N2}`.
  - `{list3}` — same format as `{list1}`. Same exclusion rule as `{list2}`.

- inside `disable-startup.summary`:
  - `{N4}` — `output.loginItems.length` from Step 4
  - `{list4}` — comma-separated `item.name` values, cap at 3 then `", …"` if more. If `{N4}` is 0, write `"0 login item(s): none flagged"`.

Returns `{ selected: string[] }`. Empty selection = Step 6 no-ops; Step 7 skips re-running diagnostics.

**Step 6 — Execute confirmed actions**

For each category id in Step 5's `selected`, re-derive the target list from the same classification rule used in Step 5's data lineage (the executor has Step 1 and Step 4 outputs in scratchpad), then iterate the matching tool:

- `"restart-helpers"` → for each PID classified as `restart-helpers`, call `restart_process` with `{ pid, name }`. **MUST pass `name`** — without it the tool kills the process but cannot relaunch (no `launchPath`, no `name` → "Killed PID X. No launchPath or name provided for relaunch."). `name` comes from `process.name` in Step 1's output. The tool will `kill -TERM` the PID, wait 1.5s, then `open -a "<name>"` to relaunch. G4's consent gate prompts before each execution (the tool does not support dry-run).
- `"kill-runaway-cpu"` → for each PID classified as `kill-runaway-cpu` AND NOT already in `restart-helpers` (if both categories were selected — restart wins on overlap, but classification is non-overlapping so the deduplication is normally a no-op), call `kill_process` with `{ pid, signal: "TERM" }`. G4 manages the dry-run preview + consent flow automatically. Do NOT pass `dryRun` — G4 substitutes it per the binding contract (see `docs/architecture/GUARDRAIL-ARCHITECTURE.md` "Author-authored dryRun override").
- `"kill-runaway-memory"` → for each PID classified as `kill-runaway-memory` AND NOT in `kill-runaway-cpu` selection (dedupe PIDs that already received a kill), call `kill_process` with `{ pid, signal: "TERM" }`.
- `"disable-startup"` → for each `item.name` from Step 4's `output.loginItems`, call `disable_startup_item` with `{ name: item.name }`. G4 manages the dry-run + consent flow automatically.

Each corrective step sets `inputsFrom: [{ step: <step-5-index>, field: "selected" }]` and a `Condition:` clause testing whether its category id appears in `selected`. Skip silently when the id is not in `selected`. If a process from the classification has terminated between Step 1 and Step 6 (rare but possible — the user took a long time at the gate), the tool will return a "no matching processes found" message; treat as a no-op for that PID and continue.

If `TERM` left a process alive (`kill_process` output shows it didn't terminate), the user may re-trigger the skill and escalate to `signal: "KILL"` on the second pass.

**Step 7 — Verify recovery**
Call `get_top_consumers` again with the same args as Step 1. If Step 2 reported `"warn"` or `"critical"` pressure, also call `get_memory_pressure` again. Skip both calls when Step 5's `selected` was empty AND no diagnostic concerns were flagged in Step 5's summary.

**Step 8 — Final report**
One short paragraph: which processes were acted on, what the post-action snapshot looks like, and any remaining concerns. If memory pressure or CPU temperature stayed elevated and no user-scope process was the cause, advise a system restart or escalating to IT with the Step 1–3 diagnostic snapshot.

---

## Edge cases

- **System-scope processes cannot be killed from here** — `kernel_task`, `WindowServer`, `launchd`, `loginwindow`, `coreaudiod`, `mds`, anything in `/System/`, and any process the current user does not own. macOS rejects the kill with EPERM regardless of how the agent invokes it. Always surface these via the `{systemProcessNote}` in Step 5's summary, never as a category. Advise restart or IT escalation.
- **Auto-restarting children and daemons are killed, not restarted** — Electron Helpers, Chrome Helpers, launchd daemons, Windows services all auto-respawn within seconds of being killed because their parent app or service manager brings them back. These go in `kill-runaway-cpu` / `kill-runaway-memory`, NOT `restart-helpers`. The kill IS the restart from the user's perspective.
- **Browser at the top** — top-level browsers (`Google Chrome`, `Safari`, `Firefox`, `Microsoft Edge`) ARE eligible for `restart-helpers` because they're launchable .app bundles. Mention closing tabs / disabling extensions in chat. Note: browser Helper / Renderer child processes (`Google Chrome Helper (Renderer)`) are NOT eligible — they go to kill categories where Chrome's parent process respawns them.
- **Antivirus / backup scans** — high CPU from `MsMpEng.exe` (Windows Defender), `mds_stores` (Spotlight indexing), or Time Machine is expected during scheduled scans. Surface in chat as "expected, will subside" rather than as an actionable row.
- **Thermal throttling overrides everything** — when `output.isThrottling` is true, the `{diagnosticSummary}` should lead with the throttling message. Killing processes will not fix a thermal problem; advise checking vents, hard surface, and letting the machine cool down.
- **TERM vs KILL** — Step 6 always sends `TERM`. Escalation to `KILL` requires a second user-triggered run; do not auto-escalate within a single run.
- **No elevated permissions** — `get_top_consumers` only sees processes the current user can observe. Root-owned processes may show 0% CPU even when active; the snapshot is incomplete, not wrong.
