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
  - wait_for_user_ack
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

Use the result to confirm which app the user is talking about. If `check_collab_app_status` returns `installed: false` for the app the user named, surface this to the user and stop — there is nothing to repair on this machine. The remaining Steps' `Condition:` clauses will all skip cleanly.

**Step 1b — Wait for user to sign in (if signed out)**
`Condition:` only run if Step 1 returned `authState: "signed-out"` for the user's reported app. Call `wait_for_user_ack`:

```yaml
prompt: "It looks like you're signed out of {app}. Sign in first — your symptom (mic / camera / messages / search) may resolve on its own once authentication completes. Let me know how it goes."
options:
  - { id: "fixed",        label: "Signing in fixed it",        kind: "primary" }
  - { id: "still-broken", label: "Still broken after sign-in", kind: "secondary" }
  - { id: "skip",         label: "Skip — diagnose anyway",     kind: "cancel" }
```

On `fixed`: end the run with success (Step 8 final report). On `still-broken` / `skip`: proceed to Step 2. Without this gate, Steps 2–6 would run on a signed-out account — cache clears and A/V resets would still leave the user unable to use the app.

**Step 2 — Enumerate audio devices when the symptom is media**
`Condition:` only run if the user's complaint involves mic, camera, or speaker. (The tool returns cleanly on any complaint type, so always-calling is safe-but-wasteful — skip when irrelevant.)

Call `list_audio_devices` to enumerate available audio devices and the system default. The output gives the user ground truth on what the OS sees — if the user expects "AirPods" but the audio list does not contain them, the problem is the device pairing, not the app.

**Step 2b — Enumerate video devices when the symptom is media**
`Condition:` same as Step 2. Call `list_video_devices`. Same purpose for camera devices (FaceTime HD, Continuity Camera, external webcams).

**Step 3 — Check app permissions (mic / camera / screen recording)**
`Condition:` only run if the user's complaint involves mic, camera, speaker, or screen share. Call `check_app_permissions` for the affected app:
- `appBundleId` for macOS — e.g. `com.microsoft.teams2`, `com.tinyspeck.slackmacgap`, `us.zoom.xos`, `Cisco-Systems.Spark`
- Windows path is the executable

Required permissions vary per symptom:
- **Mic problem** — Microphone permission must be granted
- **Camera problem** — Camera permission must be granted
- **Screen-share problem** — Screen Recording permission must be granted (macOS only)

If a required permission is denied, Step 3b's ack will surface the System Settings path and wait for the user to grant access.

**Step 3b — Wait for user to grant required permission (if denied)**
`Condition:` only run if Step 3 returned at least one denied permission required for the user's symptom. Call `wait_for_user_ack`:

```yaml
prompt: "{App} needs {permission} permission to handle your symptom, but it's currently denied. Open System Settings → Privacy & Security → {permission}, enable it for {app}, then relaunch the app. Let me know how it goes."
options:
  - { id: "fixed",        label: "Granted — and that fixed it", kind: "primary" }
  - { id: "still-broken", label: "Granted, still broken",       kind: "secondary" }
  - { id: "skip",         label: "Skip — diagnose anyway",      kind: "cancel" }
```

On `fixed`: end the run with success (Step 8 final report). On `still-broken` / `skip`: proceed to Step 4. Without this gate, Steps 4–6 (A/V reset, cache clear, restart) would run while the underlying permission denial remains — none of them can give the app permission it doesn't have, so the symptom would persist.

**Step 4 — Reset A/V device selection (mic / camera / speaker stuck on wrong device)**
`Condition:` only run if (a) the user's complaint involves mic / camera / speaker AND (b) Step 3b either was skipped (no denied permissions) or returned `still-broken` / `skip` AND (c) Step 1b either was skipped or returned `still-broken` / `skip`.

Call `reset_av_device_selection` with `app: <app>`. The required parameter is `app` (one of `"teams" | "slack" | "zoom" | "webex"`) — wildcards are rejected at the schema layer. G4 auto-triggers the dry-run preview (`destructive: true` + `supportsDryRun: true`) surfacing the affected file paths and which keys would be cleared, then the consent gate fires. The tool clears only the audio/video selection keys — broader app preferences and sign-in state are preserved.

Step 6's restart picks up the cleared selection — the user does NOT need to manually quit and relaunch between Steps 4 and 6.

**Step 5 — Clear app cache (stuck media / stale search / old metadata)**
`Condition:` only run if (a) the user's complaint involves stale search / stale messages / stale meeting list / sluggish behavior, OR (b) Step 4 ran and the user reports the issue persists. Skip for pure A/V symptoms where Step 4 alone is expected to fix it (cache clears are more invasive).

Call `clear_collab_app_cache` with `app: <app>`. G4 auto-triggers the dry-run preview showing which cache subdirectories will be cleared and the bytes-freed estimate, then the consent gate fires. Auth artefacts (Cookies, Local Storage, IndexedDB, accounts) are NOT cleared — the user stays signed in.

The tool deletes the cache subdirectories and reports per-path bytes freed. Errors per path (most commonly because the app is still running and holds a file lock) are returned in the `errors[]` array — partial-clear is reported as success with errors enumerated. Step 6's restart resolves most lock errors.

**Step 6 — Restart the app**
`Condition:` only run if Step 4 OR Step 5 ran. Call `restart_process` with the app's process name. The process name is NOT derivable from Step 1's `installPath` (e.g. macOS Teams installs at `/Applications/Microsoft Teams.app` but the running process is `MSTeams`). Use this hardcoded mapping:
- Teams (macOS new) → `MSTeams`
- Slack → `Slack`
- Zoom → `zoom.us` (macOS) / `Zoom` (Windows)
- Webex → `Webex`

The tool does NOT support dry-run (`supportsDryRun: false`). G4's consent gate fires automatically before the restart. After the restart, the user should see the app re-detect A/V devices (if Step 4 ran) and rebuild its cache (if Step 5 ran).

**Step 7 — Wait for user to test the app**
`Condition:` only run if any corrective (Steps 4, 5, or 6) ran. Call `wait_for_user_ack`:

```yaml
prompt: "I've reset {app}'s {av-selection|cache|both} and restarted it. Try the original action that was broken (join meeting, test mic, search messages, etc.) and let me know whether it works now."
options:
  - { id: "works",        label: "It works now",                kind: "primary" }
  - { id: "still-broken", label: "Still not working",           kind: "secondary" }
  - { id: "skip",         label: "Skip — I'll test later",      kind: "cancel" }
```

On `works`: report success and end the run. On `still-broken`: surface the IT-escalation guidance in the response (network firewall, identity-layer issue via `identity-auth-repair`, corrupt install via `software-reinstall`). On `skip`: close with "diagnostics complete; user will verify later".

**Step 8 — Final report**
Summarise what was changed:
- Which app was diagnosed (Step 1)
- Sign-in state and whether sign-in alone resolved it (Step 1b)
- A/V permission state and whether granting alone resolved it (Step 3 / 3b)
- Whether A/V device selection was reset (Step 4) — and which device the app should now pick up
- Whether cache was cleared (Step 5) — and bytes freed
- Whether the app was restarted (Step 6)
- The user's final-test ack outcome (Step 7)

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
