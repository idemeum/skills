# Running out of disk space

**Skill:** `disk-cleanup` · **Risk:** high · **Steps:** 11

Scans disk usage and removes large or temporary files to free space.

## What it does, step by step

**Step 1.** Scans the top-level folders in the user's home directory to find where space is being used.
_read-only_ · `disk_scan`

**Step 2.** Finds the ten largest files, over 100 MB, stored in the user's home directory.
_read-only_ · `get_large_files`

**Step 3.** Finds duplicate files taking up extra space and lists the best candidates to remove.
_read-only_ · `find_duplicate_files`

**Step 4.** Lists downloads older than 90 days and larger than 50 MB that are likely safe to delete.
_read-only_ · `find_old_downloads`

**Step 5.** Checks how much space application caches are using, without deleting anything.
_read-only_ · `get_app_cache_info`

**Step 6.** Checks how much space browser caches are using, without deleting anything.
_read-only_ · `get_browser_cache_info`

**Step 7.** Checks developer tool and Docker caches for reclaimable space, without deleting anything.
_read-only_ · `get_dev_cache_info`, `get_docker_disk_usage`, `get_xcode_derived_data_info`

**Step 8.** Checks how many items are in the Trash and how much space they take up.
_read-only_ · `get_trash_info`

**Step 9.** Shows the user a summary of all reclaimable space and lets them choose what to clean up.
_asks the user, conditional_ · `present_preview`

**Step 10.** Deletes the files and caches the user approved, after one final confirmation.
_deletes data, asks permission, preview first, conditional_ · `delete_files`, `clear_app_cache`, `clear_browser_cache`, `clear_dev_cache`, `clear_xcode_derived_data`, `prune_docker`, `empty_trash`

**Step 11.** Reports how much free space remains and how much was recovered overall.
_read-only_ · `get_disk_usage`

## Tools it may use

`disk_scan`, `get_disk_usage`, `get_large_files`, `find_duplicate_files`, `find_old_downloads`, `get_app_cache_info`, `get_browser_cache_info`, `get_dev_cache_info`, `get_docker_disk_usage`, `get_trash_info`, `get_xcode_derived_data_info`, `clear_app_cache`, `clear_browser_cache`, `clear_dev_cache`, `prune_docker`, `clear_xcode_derived_data`, `delete_files`, `empty_trash`, `present_preview`
