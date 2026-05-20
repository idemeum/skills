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
  - get_app_cache_info
  - get_browser_cache_info
  - get_dev_cache_info
  - get_docker_disk_usage
  - get_trash_info
  - get_xcode_derived_data_info
  - clear_app_cache
  - clear_browser_cache
  - clear_dev_cache
  - prune_docker
  - clear_xcode_derived_data
  - delete_files
  - empty_trash
  - present_preview
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

**Step 2 — Find large files**
Call `get_large_files` **once** on the home directory with `minSizeBytes: 100000000` (100 MB) and `limit: 10`. The tool returns `output.files: [{ path, size, sizeHuman, modified }]` for Steps 9 and 10 to consume. Do NOT iterate per folder.

**Step 3 — Find duplicate files**
Call `find_duplicate_files` **once** on the home directory with `minSizeMb: 10` and `topDeletableLimit: 10`. The tool returns `output.topDeletables: [{ path, sizeBytes }]` for Steps 9 and 10 to consume. Do NOT iterate per folder.

**Step 4 — Check old downloads**
Call `find_old_downloads` with `olderThanDays: 90` and `minSizeMb: 50` to list stale downloads ≥50 MB. Installers (.dmg, .pkg, .exe) older than 90 days are almost always safe to remove.

**Step 5 — Check application caches**
Call `get_app_cache_info` to list all app cache directories and their sizes. Present the largest caches. Ask the user if they want to clear specific ones or all. This is a read-only probe — nothing is deleted at this step.

**Step 6 — Check browser caches**
Call `get_browser_cache_info` to report browser cache sizes (Chrome, Safari, Firefox, Edge). Browser caches are always safe to clear — they rebuild automatically on next use. This is a read-only probe.

**Step 7 — Check developer caches (if applicable)**
If the user is a developer or has large ~/Library entries:
- Call `get_dev_cache_info` to report npm/yarn/pnpm/pip/gradle/maven cache sizes (read-only)
- Call `get_docker_disk_usage` if relevant — reports reclaimable bytes via `docker system df` without modifying anything; returns `dockerInstalled:false` when Docker is unavailable so the caller can branch
- Call `get_xcode_derived_data_info` on macOS to report DerivedData / Archives / DeviceSupport sizes (read-only; returns `supported:false` on non-darwin)

**Step 8 — Check Trash contents (always include)**
This step MUST be included in every disk-cleanup plan — the Trash is a frequent source of reclaimable space, and the consolidated `present_preview` card lets the user opt in or out of emptying it. Do not treat this step as optional even if the user's goal did not explicitly mention Trash.

Call `get_trash_info` to report Trash item count and total size. This is a read-only probe — nothing is deleted. The corrective `empty_trash` invocation in Step 10 (gated on `'trash'` being in the user's `present_preview` selection) is the single user-facing surface that actually empties the Trash, fronted by the G4 consent gate.

**Step 9 — Present consolidated cleanup plan**

Call `present_preview` with:

```yaml
title: "Cleanup Plan"
summary: "You can recover {totalSize} by cleaning the following:"
categories:
  - id: large-files
    label: "Large files"
    summary: "{N} files over 100 MB ({size})"
    defaultSelected: true

  - id: duplicates
    label: "Duplicate files"
    summary: "{N} duplicate files ({size})"
    defaultSelected: true

  - id: old-downloads
    label: "Old downloads"
    summary: "{N} installers/archives older than 90 days ({size})"
    defaultSelected: true

  - id: app-cache
    label: "App caches"
    summary: "Slack, Spotify, Discord, etc. ({size})"
    defaultSelected: true

  - id: browser-cache
    label: "Browser caches"
    summary: "Chrome, Safari, Edge — rebuild automatically ({size})"
    defaultSelected: true

  - id: dev-cache
    label: "Developer caches"
    summary: "npm, yarn, pip, gradle, Xcode DerivedData ({size})"
    destructive: true
    defaultSelected: false

  - id: docker
    label: "Docker resources"
    summary: "Unused images, containers, volumes ({size})"
    destructive: true
    defaultSelected: false

  - id: trash
    label: "Trash"
    summary: "{N} items ({size})"
    defaultSelected: true
```

Data lineage (executor LLM substitutes `{placeholder}` tokens at runtime from prior scratchpad outputs):

- top-level `{totalSize}` — sum of every category's size, formatted human-readable
- inside large-files.summary:
  - `{N}` — `output.returned` from the Step 2 `get_large_files` call.
  - `{size}` — sum of `file.size` across every entry in `output.files` from Step 2, formatted human-readable.
- inside duplicates.summary:
  - `{N}` — `output.topDeletables.length` from the Step 3 `find_duplicate_files` call (bounded to ≤10 by `topDeletableLimit: 10`).
  - `{size}` — sum of `sizeBytes` across every entry in `output.topDeletables` from Step 3, formatted human-readable. (Note: `find_duplicate_files` omits `duplicateGroups` and `totalWastedBytes` from its output whenever `topDeletableLimit` is set, so those scan-wide aggregates aren't available to mistakenly pick.)
- inside old-downloads.summary:
  - `{N}` — length of `output.oldFiles` from the `find_old_downloads` step
  - `{size}` — `output.totalHuman` from the `find_old_downloads` step (pre-formatted decimal/SI by the tool; substitute the string verbatim, do NOT recompute from `totalBytes`)
- inside app-cache.summary:
  - `{size}` — `output.totalHuman` from the `get_app_cache_info` step (pre-formatted decimal/SI by the tool; substitute the string verbatim, do NOT recompute from `totalBytes`)
- inside browser-cache.summary:
  - `{size}` — `output.totalHuman` from the `get_browser_cache_info` step (pre-formatted decimal/SI by the tool; substitute the string verbatim, do NOT recompute from `totalBytes`)
- inside dev-cache.summary:
  - `{size}` — `output.totalHuman` from the `get_dev_cache_info` step (pre-formatted decimal/SI by the tool; substitute the string verbatim, do NOT recompute from `totalBytes`)
- inside docker.summary:
  - `{size}` — `output.totalReclaimableHuman` from the `get_docker_disk_usage` step (pre-formatted decimal/SI by the tool; substitute verbatim, do NOT recompute). Omit the category entirely when `dockerInstalled` is false.
- inside trash.summary:
  - `{N}` — `output.itemCount` from the `get_trash_info` step
  - `{size}` — `output.totalHuman` from the `get_trash_info` step (pre-formatted decimal/SI by the tool; substitute verbatim, do NOT recompute from `totalBytes`)

The card stays visible until the user submits; the gate returns `{ selected: string[] }` carrying the category ids the user kept checked. Empty selection = cancel; downstream corrective steps no-op.

**Step 10 — Execute confirmed cleanups**

For each category id in Step 9's `selected` output, re-call the relevant tool with `dryRun: false`:

- `"large-files"`    → call `delete_files` **once** with `paths: [<every file.path from Step 2's output.files>]`. Step 2 already returns at most 10 files via `limit: 10`, so this is naturally bounded. A single batched call produces one dry-run preview (listing all files) and one consent prompt — never iterate per file.
- `"duplicates"`     → call `delete_files` **once** with `paths: [<every entry.path from Step 3's output.topDeletables>]`. Step 3 already returned at most 10 pre-sorted deletables via `topDeletableLimit: 10`, so no per-group selection logic is needed at this step. A single batched call produces one dry-run preview (listing all files) and one consent prompt — never iterate per file.
- `"old-downloads"`  → collect every `oldFiles[].path` from the `find_old_downloads` output and call `delete_files` **once** with `paths: [<all old-download paths>]`. A single batched call produces one dry-run preview (listing every stale download) and one consent prompt — never iterate per file.
- `"app-cache"`      → call `clear_app_cache` with `dryRun: false`
- `"browser-cache"`  → call `clear_browser_cache` with `browser: "all"`, `dryRun: false`
- `"dev-cache"`      → call `clear_dev_cache` with `dryRun: false`; on macOS also call `clear_xcode_derived_data` with `dryRun: false`
- `"docker"`         → call `prune_docker` with `dryRun: false`
- `"trash"`          → call `empty_trash` with `dryRun: false`

Each corrective step sets `inputsFrom: [{ step: <step-9-index>, field: "selected" }]` and a `When:` clause testing whether its category id is in the selection (e.g. `only if "large-files" is in Step 9's selected`). Skip silently when the category id is not in `selected`.

**Step 11 — Final report**
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
