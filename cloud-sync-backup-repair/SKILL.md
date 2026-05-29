---
name: cloud-sync-backup-repair
description: Diagnoses and repairs cloud sync (OneDrive, iCloud Drive, Google Drive, Dropbox) and Time Machine backup problems including stuck queues, stale sync state, missed backups, sync conflicts on slow networks, and credential / token expiry. Read-only probes by default; the only mutating tool is `pause_resume_cloud_sync` and it is reversible. Use when the user reports their cloud files are not syncing, OneDrive shows a red X, or they are unsure when their last backup ran.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS (Time Machine probe macOS-only)
allowed-tools:
  - check_cloud_sync_status
  - pause_resume_cloud_sync
  - check_timemachine_status
  - check_connectivity
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - check_cloud_sync_status
      - check_timemachine_status
  maxAggregateRisk: medium
  userLabel: "OneDrive / iCloud / Dropbox / Time Machine sync or backup problem"
  examples:
    - "OneDrive won't sync"
    - "iCloud says syncing forever"
    - "when was my last Time Machine backup?"
    - "Google Drive is stuck"
    - "my Dropbox icon is red"
    - "files aren't showing up on my other Mac"
  pill:
    label: Fix Cloud Sync
    goal: My cloud sync (OneDrive, iCloud, Google Drive, Dropbox) or Time Machine backup is stuck, stale, or showing errors — please diagnose and fix it
    icon: CloudUpload
    iconClass: text-blue-500
    order: 13
  proactive-triggers:
    # Wave 2 Track B Phase 4 — Trigger 4 (data-at-risk anxiety driver, QBR talking point).
    - name: cloud-sync-stale
      telemetry:
        tool: check_cloud_sync_status
        intervalMs: 3600000      # 1 h
      condition: "stale == true"
      duration: 24h              # Hysteresis: 24h continuous staleness before firing
      autofix: false
      severity: medium
    # Wave 2 Track B Phase 4 — Trigger 5 (ransomware insurance; macOS only).
    # check_timemachine_status returns status:"not-supported" + stale:false on Windows,
    # so this trigger naturally never fires on Windows machines.
    - name: timemachine-stale
      telemetry:
        tool: check_timemachine_status
        intervalMs: 21600000     # 6 h
      condition: "stale == true"
      duration: 72h              # 3-day window matches the conventional backup-stale threshold
      autofix: false
      severity: medium
---

## When to use

Use this skill when the user:
- Reports OneDrive / iCloud Drive / Google Drive / Dropbox is not syncing or is stuck
- Says they see a sync error icon (red X, exclamation, "couldn't sync")
- Wants to know when their last backup ran
- Reports files appear on one device but not another
- Asks "is my data backed up?" or "is my OneDrive working?"
- Reports a slow network (VPN, hotel) is making sync unusable and wants to pause until they're back on a fast link

Do NOT use this skill for non-sync file problems (file corruption, deleted files, lost work) — those are recovery tasks, not sync repair. Do NOT use this skill to migrate data between cloud providers — that is a configuration task.

---

## Steps

**Step 1 — Detect installed sync clients + Time Machine state**

Call `check_cloud_sync_status` and (on macOS) `check_timemachine_status` in parallel. Both are read-only and cheap. Together they give you:

- Per-client install state, last-sync timestamp, status, and a `stale` flag (cloud sync)
- Time Machine last-backup timestamp, configured destination, current status, `stale` flag

**Top-level fields on `check_cloud_sync_status`** are the most-stale installed client's summary (with `client: "auto"`, the default). The `clients[]` array under that has the per-client breakdown for the user-visible report.

If neither tool surfaces an issue (`stale: false` everywhere), the user's complaint may be about a specific file rather than overall sync — surface this and end the run with the suggestion to describe the symptom in more detail. All downstream Conditions skip cleanly.

**Step 2 — Pick the target client (prose decision)**

This is a tool-less step — the executor LLM picks the target client from the user's goal, mapped to one of `onedrive | icloud | google-drive | dropbox` (cloud-sync path) or branches to the Time Machine path. Mapping:

| User report | Target client |
|---|---|
| "OneDrive…" | onedrive |
| "iCloud…" / "files not syncing between Mac and iPhone" | icloud |
| "Google Drive…" / "My Workspace files…" | google-drive |
| "Dropbox…" | dropbox |
| "Time Machine…" / "When was my last backup?" | (Time Machine — Step 7) |

If the user said "cloud files" generically, use the client `check_cloud_sync_status` flagged as `stale` (top-level `client` field) as the target. Steps 3–6 then run against the cloud-sync target; Step 7 runs against Time Machine if that was the picked branch.

**Step 3 — Verify network connectivity**

`Condition:` only run if (a) Step 2 picked a cloud-sync target (not Time Machine) AND (b) Step 1's target client returned `stale` OR `error` status. Skip if Step 1 shows the client is healthy (network is fine if the client was recently syncing).

Call `check_connectivity` against the appropriate cloud service hostname:
- OneDrive: `graph.microsoft.com`
- iCloud Drive: `p01-content.icloud.com` (or `www.icloud.com` for a coarse probe)
- Google Drive: `drive.google.com`
- Dropbox: `client.dropbox.com`

If the host is unreachable, sync isn't going to work — surface this to the user. Common cause: the user is on a captive-portal Wi-Fi (hotel, airport) and hasn't completed the portal login. Less common but real: corporate firewall is blocking the cloud service. For pure network failures (not captive portal), escalate to the `network-reset` skill rather than continuing here.

**Step 4 — Interpret the sync state**

This is a tool-less interpretation step — re-read `check_cloud_sync_status` output from Step 1 for the target client and route the next steps:

- **`status: "stale"` + `lastSyncMs` more than 24h old** → sync has stopped. Either (a) the client process crashed and is no longer running, (b) credentials expired (escalate to `cloud-idp-password-reset`), (c) the client is paused, (d) network partition. Step 5's pause-then-resume un-stick may help case (c) and sometimes case (a).
- **`status: "idle"`** → sync is working and current. The user's symptom is likely about a specific file rather than the engine — surface this and skip to Step 9 final report.
- **`status: "error"`** → the client surfaced an error. The current alpha tooling does not extract per-error detail; surface advice to open the client's UI to read the error message. End the run via Step 9 final report — Steps 5/6 (pause/resume) won't help an error state.
- **`status: "not-installed"`** → wrong target. The user named a client that isn't installed; report this and end the run.

**Step 5 — Pause the target client**

`Condition:` only run if (a) Step 2 picked a cloud-sync target AND (b) the user's intent is either "pause for slow network" OR "un-stick a stuck sync engine" (per Step 4's `stale` interpretation).

Call `pause_resume_cloud_sync` with `client: <target>` and `action: "pause"`. The required `client` parameter is one of `"onedrive" | "google-drive" | "dropbox" | "icloud"`. iCloud is rejected programmatically — the tool returns `outcome: "not-supported"` with guidance to use System Settings (Apple Menu → System Settings → Apple ID → iCloud).

The G4 consent gate fires automatically (`requiresConsent: true`) with the dry-run preview surfaced inside the consent card (`supportsDryRun: true`) — the user sees the exact command (e.g. `OneDrive --command pauseSyncing`) before approving. Pause is reversible (Step 6's resume restores active syncing without data loss).

**Slow-network use case**: if the user's intent is to free bandwidth and stay paused until they're back on a fast network, end the run after Step 5 succeeds — do NOT proceed to Step 5b. Surface in the response: *"Sync is paused. Run this skill again with 'resume sync' when you want it back on."*

**Stuck-sync use case**: if the user's intent is to un-stick a frozen sync engine, proceed to Step 5b's ack gate and then Step 6's resume call.

**Step 5b — Wait for the sync engine to settle (stuck-sync only)**

`Condition:` only run if Step 5 ran AND the user's intent is "un-stick stuck sync" (NOT the slow-network pause-and-stay use case). Call `wait_for_user_ack`:

```yaml
prompt: "I've paused {client}. Wait ~10–30 seconds for the sync engine state to clear, then click below — I'll resume sync and verify it picked up."
options:
  - { id: "resume-now",    label: "Resume now",                kind: "primary" }
  - { id: "leave-paused",  label: "Leave it paused (I'll resume later)", kind: "cancel" }
```

This gate makes the wait explicit. The agent has no sleep tool, so without this gate the executor would call `pause` then immediately call `resume` back-to-back — defeating the un-stick. On `resume-now` → Step 6 fires the resume. On `leave-paused` → end the run (slow-network use case mid-flight).

**Step 6 — Resume the target client (stuck-sync only)**

`Condition:` only run if Step 5b returned `resume-now`. Call `pause_resume_cloud_sync` with the same `client` and `action: "resume"`. G4 consent + dry-run-in-consent-card as in Step 5.

**Step 7 — Time Machine specifics (macOS only)**

`Condition:` only run if (a) Step 2 picked the Time Machine branch AND (b) platform is `darwin`. Skip silently on Windows (`check_timemachine_status` returns `status: "not-supported"` cleanly).

Branch on Step 1's `check_timemachine_status` output:

- **`status: "running"`** → backup is in progress. Phase field tells the user what stage. Surface this and end the run — nothing to fix.
- **`status: "idle"` + `stale: false`** → backup is recent and healthy. Confirm the last-backup time + destination to the user.
- **`status: "stale"` + `stale: true`** → most recent backup is older than 72h. Common causes:
  - Backup destination disconnected (external drive unplugged, network drive offline)
  - Backup paused via `tmutil disable`
  - Disk error on the backup destination
- **`status: "no-destination"`** → no Time Machine destination is configured. Time Machine is not actually running. Advise the user to set up a destination via System Settings → General → Time Machine.
- **`status: "failed"`** → last backup failed. Likely destination disk error or full destination. Advise the user to plug in the backup drive (or check it has free space) and trigger a manual backup from the menu bar.

The current toolset does NOT trigger backups programmatically (`tmutil startbackup` requires admin and is invasive). Surface guidance for the user to run a manual backup from the menu bar / System Settings — the verification window (1–2 hours for the next scheduled backup) is too long for a `wait_for_user_ack` gate, so Step 9's final report advises the user to verify on their own.

**Step 8 — Verify after pause-then-resume**

`Condition:` only run if Step 6 ran (resume happened). After ~30 seconds, re-call `check_cloud_sync_status` with the same `client` (not `auto`) to verify the un-stick worked. Look for `status: "syncing"` or a fresher `lastSyncMs`. If still stale, the pause/resume did not fix it — surface this in Step 9 and escalate.

**Step 9 — Final report**

Summarise:
- Which sync client(s) the user has installed and their per-client state
- Time Machine state (if macOS and Time Machine branch ran)
- What corrective action was taken (pause-only / pause-then-resume / Time Machine guidance)
- What the user should expect next (next sync window, manual action they need to take)

Escalate to IT when:
- The cloud service is unreachable AND it's not a captive portal (corporate firewall)
- A client is in `error` state with details the user can't resolve themselves
- Time Machine destination disk shows persistent errors (hardware failure)

---

## Cross-skill redirects

Cloud-sync issues often share root causes with problems other skills handle better. Before drilling deeper into a sync diagnostic, check whether the symptom maps to one of these adjacent skills and redirect — the user gets a faster, more focused fix and the diagnostic isn't repeated:

- **Disk full / "no space" errors during sync** → use the **Disk Cleanup** skill (`disk-cleanup`) first to free space, then retry cloud sync. Sync clients commonly stop with low-space warnings that an empty `~/.Trash` or a Downloads cleanup will resolve in minutes.
- **"Stale credentials" / "expired token" / authentication-loop errors** → use the **Cloud IDP Password Reset** skill (`cloud-idp-password-reset`) to refresh the user's identity-provider credentials. SSO-mediated sync clients (OneDrive for Business, Google Drive on Workspace, iCloud after an Apple-ID password change) re-authenticate cleanly after a successful IDP reset.
- **Network unreachable / "cannot reach cloud service" with no captive portal** → use the **Network Reset** skill (`network-reset`) to restore basic connectivity (`flush_dns_cache`, `renew_dhcp_lease`, etc. — most are now non-admin via the privileged helper). Once `check_connectivity` reports the cloud endpoint reachable, retry the cloud-sync diagnostic.

When you redirect, keep the cloud-sync diagnostic state captured so far in the run report — it's still useful context for whichever skill takes over, and it goes into the IT-escalation ticket regardless of which skill closes the run.

---

## Edge cases

- **OneDrive Files On-Demand** — by default, OneDrive on macOS Sonoma+ uses File Provider (on-demand sync). Files appear locally but contents are downloaded on first open. A user reporting "the file isn't there" may actually have the placeholder but not the content. The current tooling can't differentiate; advise the user to right-click the file and select "Always keep on this device"
- **iCloud Drive Optimised Storage** — similar to OneDrive Files On-Demand, macOS may evict file content to free local space. The file appears locally but opening it triggers a download. If the user is offline + the file is evicted, opening it fails. Surface this as a likely cause when the user says "file is there but won't open"
- **Google Drive shared drive vs My Drive** — Shared Drives sync separately from My Drive. A "My Drive isn't syncing" report may be unrelated to a "Shared Drive isn't syncing" report. The current tooling reports overall client state; advise the user to look at the Drive app's sidebar for per-collection status
- **Dropbox LAN sync** — Dropbox can sync between two machines on the same LAN without round-tripping through the cloud. If both machines are online but cloud-side latency is high, this can mask cloud sync issues. `check_cloud_sync_status` reports the last on-disk activity, not whether cloud round-trip is healthy
- **iCloud "Apple ID locked"** — iCloud sync stops silently when the user's Apple ID is locked (recently changed password, security alert). The client UI shows an error; the on-disk lastSync may still be recent (from before the lock). Advise the user to sign in to iCloud.com and resolve any account-level alerts
- **Time Machine snapshots vs backups** — `tmutil` differentiates local APFS snapshots (kept on the local disk for hourly recovery) from full backups (kept on the destination). `tmutil latestbackup` returns the full backup. A user with no destination configured may still have local snapshots and report "I have backups" — the tool's `status: "no-destination"` is technically correct
- **Time Machine over network — Time Capsule / NAS** — when the destination is a network drive that is currently offline, `tmutil destinationinfo` may still list it. The probe will report `status: "stale"` with the destination name; advise the user to verify the network share is reachable
- **Backup encryption + recovery key** — Time Machine destinations may be encrypted with a per-destination password. If the password is lost, prior backups cannot be read. The current tool does NOT inspect encryption state; advise the user to test-restore a small file to confirm the destination is recoverable, separate from this skill
- **OneDrive on macOS legacy vs new client** — Microsoft has shipped multiple OneDrive clients (the legacy app, the standalone client, the App Store version). The `check_cloud_sync_status` install-path probe may detect any of them but log dirs differ. If `lastSyncMs` is stuck at install-time even though the user is using OneDrive heavily, the tool is probing the wrong path — escalate to IT for a diagnostic
- **Google Drive Workspace policies** — corporate Workspace tenants can disable certain sync features (e.g. local cache size limits, sync to USB drives). The client may report sync as healthy even when the user's expected behaviour is blocked by policy. Surface this when the user reports "I expect X to sync but it doesn't" and policy is a possibility — escalate to IT
