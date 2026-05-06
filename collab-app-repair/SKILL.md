---
name: collab-app-repair
description: Diagnoses and repairs Microsoft Teams, Slack, Zoom, and Cisco Webex problems including media issues (mic, camera, speaker), stuck cache, stale meeting metadata, and search-index failures. Preserves the user's signed-in state — clears app cache and resets A/V device selection without forcing the user to sign back in. Use when the user reports the collab app is misbehaving but their account credentials are still valid.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_collab_app_status
  - list_audio_devices
  - list_video_devices
  - clear_collab_app_cache
  - reset_av_device_selection
  - restart_process
  - check_app_permissions
  - list_installed_apps
metadata:
  prerequisites:
    before-corrective:
      - check_collab_app_status
      - list_audio_devices
      - list_video_devices
  maxAggregateRisk: medium
  userLabel: "Teams / Slack / Zoom / Webex problem"
  examples:
    - "I can't join the meeting"
    - "Teams keeps asking me to sign in"
    - "my mic isn't working on Zoom"
    - "my camera is black in Webex"
    - "Slack messages aren't loading"
    - "Teams search is broken"
  pill:
    label: Fix Collab Apps
    goal: My Teams, Slack, Zoom, or Webex app is misbehaving — mic, camera, search, or messages are not working — please diagnose and fix it without signing me out
    icon: Headphones
    iconClass: text-sky-500
    order: 12
---

## When to use

Use this skill when the user:
- Reports they can't join a meeting in Teams / Zoom / Webex
- Says their mic, camera, or speaker is not working in a specific collab app
- Reports Slack / Teams search returns no results or stale results
- Says messages or meeting metadata are out of date in the app
- Reports the app is sluggish, stuck loading, or showing yesterday's notifications
- Asks "why is my Teams not working?" or "Slack is broken"

Do NOT use this skill when the user is asking to **sign out** of the app, **uninstall** the app, or **migrate** to a different account — those are configuration tasks, not repair. If the user reports cross-app authentication problems (multiple apps prompting for login at the same time), use [identity-auth-repair](../identity-auth-repair/SKILL.md) instead — the root cause is likely identity-layer (NTP drift, expired Kerberos / SSO cert), not collab-app-specific.

---

## Steps

**Step 1 — Detect installed collab apps**
Call `check_collab_app_status` with `app: "all"` (or omit the parameter — `all` is the default). The tool returns one entry per supported app (Teams, Slack, Zoom, Webex) with `installed`, `installPath`, `cachePath`, `cacheAgeHours`, and an `authState` heuristic (`"signed-in" | "signed-out" | "unknown"`).

Use the result to confirm which app the user is talking about. If `check_collab_app_status` returns `installed: false` for the app the user named, surface this to the user and stop — there is nothing to repair on this machine.

If the user's reported app is `installed: true` but `authState: "signed-out"`, the symptom is most likely a sign-in issue rather than a cache or A/V problem — tell the user to sign in first, then re-run if the symptom persists.

**Step 2 — Enumerate A/V devices when the symptom is media**
If the user's complaint involves mic, camera, or speaker (Steps 5 and 6 below will branch on this), call `list_audio_devices` and `list_video_devices` in parallel to enumerate available devices and the system default.

The output gives you (and the user) ground truth on what the OS sees — if the user expects "AirPods" but the audio list does not contain them, the problem is the device pairing, not the app. Suggest the user re-pair the device and re-run.

**Step 3 — Check app permissions (mic / camera / screen recording)**
Call `check_app_permissions` for the affected app (`appBundleId` for macOS — e.g. `com.microsoft.teams2`, `com.tinyspeck.slackmacgap`, `us.zoom.xos`, `Cisco-Systems.Spark`; the Windows path is the executable). Required permissions vary per symptom:
- **Mic problem** — Microphone permission must be granted
- **Camera problem** — Camera permission must be granted
- **Screen-share problem** — Screen Recording permission must be granted (macOS only)

If a required permission is denied, guide the user to System Settings → Privacy & Security and re-run after they grant access. The app must be relaunched after permission changes.

**Step 4 — Decide repair path based on the user's report**

The repair path branches on the symptom:

| User report | Go to |
|---|---|
| "my mic / camera / speaker isn't working in <app>" | Step 5 (A/V reset) |
| "messages / search / meeting list is stale" | Step 6 (cache clear) |
| "the app is sluggish or stuck" | Step 6 (cache clear) followed by Step 7 (restart) |
| "the app crashes when I do X" | Step 7 (restart) only — cache clear is more invasive than needed |

If the symptom is genuinely unclear, prefer Step 5 first (smaller blast radius — only A/V settings are touched), then escalate to Step 6 if the symptom persists.

**Step 5 — Reset A/V device selection (mic / camera / speaker stuck on wrong device)**

Call `reset_av_device_selection` with `app: <app>`. The G4 dry-run + consent gates surface the affected file paths and which keys would be cleared so the user understands what changes. After consent, the tool clears only the audio/video selection keys — broader app preferences and sign-in state are preserved.

The required parameter is `app` (one of `"teams" | "slack" | "zoom" | "webex"`) — wildcards are rejected at the schema layer.

After the reset, advise the user to fully quit and relaunch the app for the change to take effect (most collab apps cache the device selection in memory until restart).

**Step 6 — Clear app cache (stuck media / stale search / old metadata)**

Call `clear_collab_app_cache` with `app: <app>`. The G4 dry-run gate shows which cache subdirectories will be cleared and the bytes-freed estimate. Auth artefacts (Cookies, Local Storage, IndexedDB, accounts) are NOT cleared — the user stays signed in.

After consent, the tool deletes the cache subdirectories and reports per-path bytes freed. Errors per path (most commonly because the app is still running and holds a file lock) are returned in the `errors[]` array — partial-clear is reported as success with errors enumerated.

If `errors[]` shows lock-related failures, advise the user to fully quit the app and re-run. Step 7 below is the natural follow-up to ensure a clean restart.

**Step 7 — Restart the app (after Step 5 or Step 6, optional)**

Call `restart_process` with the app's process name (take it from Step 1's `installPath` — e.g. for macOS Teams `MSTeams`, for Slack `Slack`, for Zoom `zoom.us`, for Webex `Webex`). The tool does NOT support dry-run (`supportsDryRun: false` per its meta) — the G4 consent gate handles user confirmation automatically.

After the restart, the user should see the app re-detect A/V devices (if Step 5 ran) and rebuild its cache (if Step 6 ran).

**Step 8 — Final report**

Summarise what was changed:
- Which app was diagnosed (Step 1)
- Whether A/V permissions were OK (Step 3)
- Whether A/V device selection was reset (Step 5) — and which device the app should now pick up
- Whether cache was cleared (Step 6) — and bytes freed
- Whether the app was restarted (Step 7)

If after all steps the symptom persists, escalate to IT — the likely remaining causes are network restrictions (firewall blocking the collab service), identity-layer issues (use [identity-auth-repair](../identity-auth-repair/SKILL.md)), or a corrupt installation that needs reinstall via [software-reinstall](../software-reinstall/SKILL.md).

---

## Edge cases

- **App is running while cache clear runs** — most collab apps hold a file lock on Cookies and IndexedDB even when the auth-related files are NOT in the clear list. The tool reports per-path errors and skips locked files, so partial cache clear succeeds. Advise the user to quit the app first if `errors[]` shows lock-related failures
- **Multiple Teams installations** — Microsoft ships "classic Teams" and "new Teams" (Microsoft Teams 2.0) which have different on-disk paths. `check_collab_app_status` reports whichever is found first; `clear_collab_app_cache` targets the new-Teams path. If the user has classic Teams, the cache clear may not find its directory — surface this and recommend migrating to new Teams
- **Slack Enterprise Grid** — Enterprise Grid users have multiple workspaces under one auth session. Cache clear affects all workspaces simultaneously; the user does not need to re-pick a workspace after clear (workspace selection lives in `Cookies` which is preserved)
- **Zoom government cloud / partner clouds** — `us02web.zoom.us` vs `dod.zoomgov.com` etc. — installation paths and bundle IDs are identical so tool detection works the same way. The cache structure is identical
- **Webex single-account vs multi-account** — `reset_av_device_selection` targets the active-account A/V config file; users with multiple accounts may need a per-account reset. The tool does not enumerate accounts in the alpha release — advise the user to switch to the affected account in Webex first if A/V is misbehaving for one specific account only
- **macOS Continuity Camera** — `list_video_devices` reports Continuity Camera (iPhone-as-webcam) with `connection: "continuity"`. The collab app may need a separate permission grant to use it. If `check_app_permissions` shows Camera granted but the iPhone camera does not appear in the app, restart the app and ensure the iPhone is on the same Wi-Fi + Bluetooth proximity to the Mac
- **Windows Hello / Windows Camera Privacy** — on Windows, mic and camera permissions are governed by Settings → Privacy & Security → Microphone / Camera AND a per-app toggle. Both must be on. `check_app_permissions` reports the per-app state; if it is off, guide the user to the Settings panel
- **Tamper-protected enterprise-managed Teams** — some MDM-managed Teams installs reject `clear_collab_app_cache` writes because cache directories are read-only-mounted. The tool surfaces this as a permission error in `errors[]`. Escalate to IT — there is no user-side remediation
