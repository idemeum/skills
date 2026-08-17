# Computer running slow or app frozen

**Skill:** `process-manager` · **Risk:** medium · **Steps:** 9

Diagnoses and resolves system performance issues caused by runaway processes, memory pressure, thermal throttling, or excessive startup items.

## What it does, step by step

**Step 1.** Identifies the processes using the most CPU and memory right now.
_read-only_ · `get_top_consumers`

**Step 2.** Checks whether the system is low on memory and swapping to disk.
_read-only_ · `get_memory_pressure`

**Step 3.** Checks the processor temperature and whether it is throttling performance.
_read-only_ · `get_cpu_temperature`

**Step 4.** Lists apps and services set to launch automatically at startup.
_read-only_ · `get_startup_items`

**Step 5.** Summarizes the findings and lets the user choose which fixes to apply.
_asks the user, conditional_ · `present_preview`

**Step 6.** Applies only the fixes the user approved, exactly as presented.
_deletes data, asks permission, preview first_ · `disable_startup_item`

**Step 7.** Rechecks resource usage and memory pressure to confirm the fixes helped.
_read-only_ · `get_top_consumers`, `get_memory_pressure`

**Step 8.** Checks whether the disk is nearly full, since that also causes slowdowns.
_read-only_ · `get_disk_usage`

**Step 9.** Summarizes what was fixed, what remains, and any recommended next steps.
_no tools_

## Tools it may use

`get_top_consumers`, `get_memory_pressure`, `get_cpu_temperature`, `get_startup_items`, `present_preview`, `restart_process`, `kill_process`, `disable_startup_item`, `get_disk_usage`
