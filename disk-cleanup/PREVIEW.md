# Running out of disk space

**Skill:** `disk-cleanup` · **Risk:** high · **Steps:** 11

Scans disk usage and removes large or temporary files to free space.

## What it does, step by step

**Step 1.** Scans the home directory to identify which top-level folders use the most disk space.
_read-only_ · `disk_scan`

**Step 2.** Finds the largest files over 100 MB in the home directory in a single scan.
_read-only_ · `get_large_files`

**Step 3.** Finds duplicate files taking up space so unnecessary copies can be removed.
_read-only_ · `find_duplicate_files`

**Step 4.** Lists old downloads over 50 MB that are more than 90 days old and likely safe to remove.
_read-only_ · `find_old_downloads`

**Step 5.** Reports how much space application caches are using, without deleting anything.
_read-only_ · `get_app_cache_info`

**Step 6.** Reports how much space browser caches are using, without deleting anything.
_read-only_ · `get_browser_cache_info`

**Step 7.** Reports space used by developer tool and Docker caches, without deleting anything.
_read-only_ · `get_dev_cache_info`, `get_docker_disk_usage`, `get_xcode_derived_data_info`

**Step 8.** Reports how many items and how much space are sitting in the Trash.
_read-only_ · `get_trash_info`

**Step 9.** Presents a consolidated cleanup plan so the user can choose which items to remove.
_asks the user, conditional_ · `present_preview`

**Step 10.** Deletes the files and caches the user approved in the cleanup plan.
_deletes data, asks permission, preview first, conditional_ · `delete_files`, `clear_app_cache`, `clear_browser_cache`, `clear_dev_cache`, `clear_xcode_derived_data`, `prune_docker`, `empty_trash`

**Step 11.** Reports updated free disk space and summarizes how much space was recovered.
_read-only_ · `get_disk_usage`

## Tools it may use

`disk_scan`, `get_disk_usage`, `get_large_files`, `find_duplicate_files`, `find_old_downloads`, `get_app_cache_info`, `get_browser_cache_info`, `get_dev_cache_info`, `get_docker_disk_usage`, `get_trash_info`, `get_xcode_derived_data_info`, `clear_app_cache`, `clear_browser_cache`, `clear_dev_cache`, `prune_docker`, `clear_xcode_derived_data`, `delete_files`, `empty_trash`, `present_preview`
