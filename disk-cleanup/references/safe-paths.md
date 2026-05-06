# Safe Paths Reference

Used by the `disk-cleanup` skill to decide what can be scanned and what must never be deleted.

---

## Paths that are safe to scan

The following directories are good starting points when looking for recoverable space:

| Path | Platform | Notes |
|------|----------|-------|
| `~/Downloads` | Both | Most common source of recoverable space |
| `~/Desktop` | Both | Often accumulates large files |
| `~/Documents` | Both | Check for large PDFs, archives, old projects |
| `~/Movies` | macOS | Large video files |
| `~/Music` | Both | Large audio libraries |
| `~/Pictures` | Both | Raw photo libraries |
| `~/.npm` | Both | npm cache — safe to delete, npm rebuilds on demand |
| `~/.yarn/cache` | Both | Yarn offline cache — safe to delete |
| `~/.cache` | macOS/Linux | General application caches |
| `~/Library/Caches` | macOS | Per-app cache folders — individual sub-folders are usually safe |
| `%LOCALAPPDATA%\Temp` | Windows | Windows temp files |
| `%APPDATA%\npm-cache` | Windows | npm cache on Windows |

---

## Paths that must NEVER be deleted

### macOS — blocked at skill level

The `delete_files` skill enforces this list and will return an error if any of these paths are targeted:

| Path | Reason |
|------|--------|
| `/` | Filesystem root |
| `/System` | Core macOS system files |
| `/Library` | System-wide libraries and frameworks |
| `/Applications` | Installed applications |
| `/usr` | Unix system binaries |
| `/bin` | Essential shell commands |
| `/sbin` | System administration binaries |
| `/etc` | System configuration files |
| `/var` | Variable system data (logs, spool) |
| `/private` | Symlink targets for /etc, /tmp, /var |
| `/private/etc` | System network / host configuration |
| `~` (home dir itself) | The home directory itself — only its contents |

### Windows — blocked at skill level

| Path | Reason |
|------|--------|
| `C:\Windows` | Core Windows OS |
| `C:\Program Files` | 64-bit installed applications |
| `C:\Program Files (x86)` | 32-bit installed applications |
| `C:\ProgramData` | Shared application data |
| `C:\System Volume Information` | System Restore / VSS snapshots |

---

## Directories skipped automatically by get_large_files

The `get_large_files` tool never descends into these directories during recursive scans:

```
node_modules        — npm/yarn packages (per project)
.git                — Git repository objects
.npm                — npm cache
.yarn               — Yarn cache and PnP files
.cache              — Generic cache directory
Library             — macOS system/app library (top-level)
__pycache__         — Python bytecode cache
.venv / venv        — Python virtual environments
$Recycle.Bin        — Windows Recycle Bin
System Volume Information
Windows             — Windows OS directory
Program Files
Program Files (x86)
```

If the user specifically wants to clean one of these directories (e.g. `node_modules` inside a project they are deleting), they must provide the explicit path to `delete_files` and confirm the action.

---

## Rules enforced by delete_files

1. **Absolute paths only** — relative paths are rejected
2. **Inside home directory only** — paths outside `os.homedir()` are rejected
3. **Home directory itself is blocked** — `~` as a target is rejected
4. **Blocked system paths** (listed above) are rejected with an error message
5. **dryRun: true must be shown first** — always present dry-run output to the user before calling with `dryRun: false`

---

## Recommended cleanup order

When guiding a disk-cleanup session, work through locations in this order (most recoverable first):

1. `~/Downloads` — large, user-owned, rarely needed after download
2. `~/.npm` / `~/.yarn/cache` — developer caches, safe and fast to clear
3. `~/Library/Caches` (macOS) — per-app caches; clear sub-folders individually
4. `~/Movies` / `~/Music` — large media, confirm with user each item
5. `~/Documents` — only delete files the user explicitly identifies
6. Trash / Recycle Bin via `empty_trash` — final step after file deletions
