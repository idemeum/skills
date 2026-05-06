---
name: disk-cleanup
description: Scans disk usage and removes large or temporary files to free space. Use when user reports laptop slowness or low disk space.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - disk_scan
  - get_disk_usage
  - get_large_files
  - find_duplicate_files
  - find_old_downloads
  - clear_app_cache
  - clear_browser_cache
  - clear_dev_cache
  - prune_docker
  - clear_xcode_derived_data
  - delete_files
  - empty_trash
metadata:
  prerequisites:
    before-corrective:
      - disk_scan
      - get_large_files
      - find_duplicate_files
      - find_old_downloads
  maxAggregateRisk: high
  userLabel: "Running out of disk space"
  examples:
    - "my laptop is running out of room"
    - "I'm getting low storage warnings"
    - "disk is almost full"
    - "not enough space on my Mac"
    - "my computer says the disk is full"
  pill:
    label: Clean Disk
    goal: My disk is full or my Mac is running slow due to low storage, please scan and free up space
    icon: HardDrive
    iconClass: text-amber-500
    order: 1
  proactive-triggers:
    # Wave 2 Track B Phase 4 — Trigger 1 (highest-volume universal preventable ticket).
    # See docs/skills/SKILL-ROADMAP.md "L2 activation priority" for the impact ranking.
    - name: disk-nearly-full
      telemetry:
        tool: get_disk_usage
        intervalMs: 3600000      # 1 h — disk fullness is steady-state, slow polling is fine
      condition: "usagePercent >= 90"
      duration: immediate
      autofix: false
      severity: high
---

## When to use

Use this skill when the user:
- Reports their computer is running slow or storage is almost full
- Sees a "disk full" or "low storage" warning from the OS
- Wants to free space before a large download, system update, or install
- Asks "what is using my disk space?", "why is my hard drive full?", or "can you clean up my Mac / PC?"

Do NOT use this skill for process or memory issues — use the `process-manager` skill instead.

---

## Steps

**Step 1 — Identify large top-level folders**
Call `disk_scan` on the user home directory to list every immediate child folder and file sorted largest first.

**Step 2 — Present findings**
Show the top 10 results with human-friendly sizes (e.g. 12.4 GB, 850 MB). Call out unexpectedly large entries and well-known cache locations.

**Step 3 — Drill into large folders**
For any unusually large folder (Downloads, Desktop, Documents, Movies, a project directory), call `get_large_files` with `minSizeBytes: 52428800` (50 MB) to surface the specific files inside. Repeat for each large folder of interest.

**Step 4 — Check for duplicate files**
Call `find_duplicate_files` on the home directory with `minSizeMb: 10` to find identical files wasting space. Present duplicate groups sorted by wasted space — photo and video duplicates are often the largest wins.

**Step 5 — Check old downloads**
Call `find_old_downloads` with `olderThanDays: 90` to list stale downloads. Installers (.dmg, .pkg, .exe) older than 90 days are almost always safe to remove.

**Step 6 — Check application caches**
Call `clear_app_cache` with `dryRun: true` (no appName) to list all app caches and their sizes. Present the largest caches. Ask the user if they want to clear specific ones or all.

**Step 7 — Check browser caches**
Call `clear_browser_cache` with `dryRun: true` and `browser: "all"` to report browser cache sizes. Browser caches are always safe to clear — they rebuild automatically on next use.

**Step 8 — Check developer caches (if applicable)**
If the user is a developer or has large ~/Library entries:
- Call `clear_dev_cache` with `dryRun: true` to report npm/yarn/pip/gradle/maven cache sizes
- Call `prune_docker` with `dryRun: true` if Docker is installed — note that `prune_docker` is marked `requiresConsent: true` in its meta, so when later called with `dryRun: false` the G4 consent gate will fire automatically and prompt the user for confirmation (no need to ask separately before invoking)
- Call `clear_xcode_derived_data` with `dryRun: true` on macOS if Xcode DerivedData appears large

**Step 9 — Summarise and confirm**
Present a consolidated cleanup plan grouped by category with total potential space recovery for each:
- Large files and folders
- Duplicate files
- Old downloads
- App caches
- Browser caches
- Developer / Docker caches

Ask the user to confirm which categories they want to proceed with.

**Step 10 — Execute confirmed cleanups**
For each confirmed category, re-call the relevant tool with `dryRun: false`:
- `delete_files` for large files and old downloads (always show `dryRun: true` output first, confirm, then execute)
- `clear_app_cache` for app caches
- `clear_browser_cache` for browser caches
- `clear_dev_cache` for developer caches
- `prune_docker` for Docker resources
- `clear_xcode_derived_data` for Xcode artifacts

**Step 11 — Check and empty Trash (always include)**
This step MUST be included in every disk-cleanup plan — the Trash is a frequent source of reclaimable space and the G4 consent gate handles user confirmation automatically. Do not treat this step as optional even if the user's goal did not explicitly mention Trash.

Call `empty_trash` with `dryRun: true` to report Trash contents and size. The G4 dry-run and consent gates will present the preview to the user and ask for confirmation before anything is deleted. If the user confirms, the follow-up call with `dryRun: false` empties the Trash.

**Step 12 — Final report**
Summarise total space recovered across all operations. Optionally call `disk_scan` again on the home directory to show the updated sizes.

---

## Edge cases

- **Never delete outside home directory** — `delete_files` enforces this at the skill level and will return an error for any blocked path; do not attempt to work around it
- **Never delete system directories** — see `references/safe-paths.md` for the full blocked list on macOS and Windows
- **Always run dryRun: true first** — never call `delete_files` with `dryRun: false` without first showing the user the dry-run output
- **Downloads folder** — always warn the user explicitly before deleting the entire Downloads folder; offer to scan it with `get_large_files` first so they can choose individual files
- **macOS Library** — `~/Library` contains application support files; do not recommend deleting it wholesale; only specific cache sub-folders if the user requests
- **Empty disk_scan output** — if `disk_scan` returns an empty entry list (permission-denied root), try calling `get_large_files` on the home directory as a fallback
- **Symlinks** — `disk_scan` and `get_large_files` may report symlinks; do not delete symlink targets without confirming the user understands what they point to
- **node_modules** — safe to delete if the user no longer needs the project; always confirm the project name and that they can reinstall with `npm install`

---

## References

See `references/safe-paths.md` for the complete list of directories that are safe to scan and paths that must never be touched.
