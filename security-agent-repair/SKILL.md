---
name: security-agent-repair
description: Diagnoses and repairs endpoint security agent issues including stopped processes, outdated versions, unapproved system extensions, connectivity failures to management consoles, and compliance posture problems. Supports CrowdStrike Falcon, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - survey_security_agent
  - survey_compliance_posture
  - check_system_extension
  - check_agent_logs
  - check_agent_process
  - restart_process
  - enable_firewall
  - c_mdm_diagnose_configuration
  - c_mdm_reapply_configuration
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - survey_security_agent
      - survey_compliance_posture
      - check_system_extension
      - check_agent_logs
  # Raised from medium when the MDM branch landed: c_mdm_reapply_configuration
  # is riskLevel high, and G2 blocks the whole plan when any step exceeds this
  # ceiling. The local correctives remain medium; the high step is the MDM
  # re-apply, which is consent-gated and non-destructive.
  maxAggregateRisk: high
  userLabel: "Security or endpoint agent not running"
  examples:
    - "my security software is not running"
    - "the endpoint agent is showing as unhealthy"
    - "CrowdStrike says it needs attention"
    - "my security agent has stopped"
    - "compliance check is failing on my device"
  pill:
    label: Security Agent
    goal: My endpoint security agent is not running or showing as unhealthy — diagnose what's wrong and either repair it or escalate to IT with the full diagnostic packet
    icon: Shield
    iconClass: text-indigo-500
    order: 6
---

## When to use

Use this skill when the user:
- Receives a notification that their security agent is not running or has stopped
- Gets a compliance warning from IT saying their endpoint is unprotected
- Reports the security agent icon is missing from the menu bar / taskbar
- Has been told by IT their machine shows as "unmanaged" or "out of compliance"
- Reports the security agent is consuming excessive CPU or memory
- Asks "why is CrowdStrike/SentinelOne/Defender not working?" or "my endpoint protection stopped"

Do NOT use this skill to disable or remove security agents — that is a compliance violation and outside the scope of self-service repair. If the user requests this, decline and advise them to contact IT.

---

## Steps

**Step 1 — Survey the security agent**
Call `survey_security_agent`. One call detects every known agent, reads each installed version, and checks when the agent last reported to its management console. Read:
- `anyDetected: false` → **end the run here**: *"I couldn't detect a known security agent on this device. If you know your IT uses a custom or non-standard EDR, please contact IT directly — this skill supports CrowdStrike, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender."* Every later step's condition skips cleanly on this.
- `detectedAgents[]` / `anyRunning` — which agents are installed and which have stopped. A stopped agent is the fault this skill repairs; do not restart it until the blockers below are ruled out.
- `versions` — one entry per supported vendor. An outdated version may be *intentionally* stopped by the console: some platforms auto-quarantine agents below a minimum version, so a restart will not hold.
- `heartbeat` — when the agent last reached its console. Not reporting means IT has no visibility even if the process is alive, which is itself worth escalating.
- `unsupportedVendors[]` — detected agents this toolchain has no version or heartbeat support for. Say so in the final report ("console reachability not tested") rather than omitting it.

**Step 2 — Check system extension approval (macOS only)**
`Condition:` only run if platform is `darwin`. On Windows, `check_system_extension` falls back to checking services / Defender status — the macOS-specific approval flow does not apply, so skip Step 2b's user-approval ack on Windows.

Call `check_system_extension`. The tool accepts an optional `bundleId: string` to target a specific extension — omit it to list every registered extension, or pass the agent's bundle ID when targeting a specific agent identified in Step 1. Known bundle IDs:
- CrowdStrike Falcon — `com.crowdstrike.falcon.Agent`
- SentinelOne — `com.sentinelone.agent-control`
- Jamf Protect — `com.jamf.protect.daemon`
- Microsoft Defender — `com.microsoft.wdav.epsext`
- Carbon Black — `com.carbonblack.es-extension`
- Cylance — `com.blackberry.cylance-es-loader`

An unapproved or "waiting for user" extension is one of the most common causes of agents appearing installed but non-functional. Step 2b's ack will gate the user's approval action.

**Step 2b — Wait for user to approve the system extension (macOS only)**
`Condition:` only run if (a) platform is `darwin` AND (b) Step 2 returned at least one extension with status `waiting-for-user` (or vendor-equivalent "pending approval"). Call `wait_for_user_ack`:

```yaml
prompt: "Your security agent's system extension needs approval. Open System Settings → Privacy & Security → scroll to the Security section → click Allow next to the extension notification. The agent will activate within 30–60 seconds after approval. Let me know when you've done it."
options:
  - { id: "approved",        label: "I approved it",                  kind: "primary" }
  - { id: "blocked-by-mdm",  label: "It's blocked by MDM",            kind: "secondary" }
  - { id: "not-there",       label: "I don't see the notification",   kind: "secondary" }
  - { id: "skip",            label: "Skip — diagnose anyway",         kind: "cancel" }
```

On `approved`: continue. On `blocked-by-mdm`: end the run with IT escalation (MDM policy needed; user cannot approve MDM-blocked extensions through System Settings). On `not-there`: end the run with reinstall recommendation (`software-reinstall` skill — IT-managed). On `skip`: proceed to Step 4 but the agent will remain non-functional.

**Step 3 — Review agent logs**
Call `check_agent_logs` for the affected agent with `errorOnly: true` to surface recent errors and warnings. Look for:
- Authentication or certificate errors → the agent's enrollment certificate may have expired
- Network timeout errors → connectivity issue to management console (Step 1's `heartbeat` already surfaced this)
- Extension or kernel errors → system extension problem (Step 2 / 3b already surfaced this)
- "Tamper protection" or "policy violation" messages → IT has locked the agent configuration; escalate to IT

**Step 4 — Restart the agent**
`Condition:` only run if (a) Step 1 returned `anyRunning: false` AND (b) no blocking issue was found — the extension is approved (or not applicable), the version in Step 1's `versions` is not one the console would quarantine, and Step 2's logs show no tamper-protection entry. Skip when the agent is already running, or when a blocker was found: a restart cannot succeed until the blocker is resolved, and attempting it hides the real cause.

Call `restart_process` with `name` from Step 1's `detectedAgents[].processName` (`inputsFrom: [{ step: 1, field: "detectedAgents" }]`) — e.g. `"com.crowdstrike.falcon.Agent"`, `"SentinelAgent"`, `"wdavdaemon"`. The tool does NOT support dry-run (`supportsDryRun: false`). The G4 consent gate handles user confirmation automatically (`requiresConsent: true`, `destructive: true`, `riskLevel: medium`).

**Privilege reality.** All enterprise security agents run as **root** (macOS) or **SYSTEM** (Windows). When a non-admin user attempts to restart one without the helper daemon, the OS rejects with EPERM / "Access denied". The privileged helper daemon (default — `HELPER_DAEMON_ENABLED=true`) routes `restart_process` for the agent and completes silently for **all users — admin and non-admin alike**. **Tamper protection** is a separate blocker — even an admin call fails if the agent's tamper protection is enabled (most enterprise deployments); the proper path is via the management console (Falcon Console → Host Management → Restart Sensor; Microsoft 365 Defender portal). Step 4b's ack surfaces the vendor-UI refresh fallback when the OS call denies.

Read `stillRunning` from the result — the tool waits and confirms the process is actually alive, so do NOT re-call `check_agent_process` to find that out. `stillRunning: false` means the agent was re-launched and stopped again immediately, which points at tamper protection or a blocker Steps 2–3 did not surface; report that rather than claiming a fix. `null` means the check could not be made. Then re-call `check_agent_heartbeat` to confirm the agent is reporting to console — that is a different question the restart cannot answer.

**Step 4b — Wait for user to try vendor-UI refresh (fallback)**
`Condition:` only run if Step 4 ran AND denied (`denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`) OR returned EPERM / tamper-protection error. Call `wait_for_user_ack`:

```yaml
prompt: "I couldn't restart the agent directly — most enterprise agents block restart from user space (tamper protection) or need admin rights the agent doesn't have. Most vendors have a built-in 'refresh' action that works WITHOUT admin: CrowdStrike Falcon → menu-bar icon → 'Refresh sensor connection'; SentinelOne → tray icon → 'Reset agent'; Microsoft Defender → open Defender → Settings → 'Sync'; Jamf Protect → menu-bar icon → 'Check in now'; Carbon Black → tray icon → 'Send Status'. Try it and let me know."
options:
  - { id: "refreshed",          label: "I ran the vendor refresh",      kind: "primary" }
  - { id: "no-option-available", label: "Vendor has no refresh option",  kind: "secondary" }
  - { id: "skip",               label: "Skip — escalate to IT",         kind: "cancel" }
```

On `refreshed`: re-call `check_agent_process` with the agent name to confirm it recovered post-refresh. On `no-option-available` / `skip`: end the run with management-console escalation advice (Falcon Console → Host Management → Restart Sensor; Microsoft 365 Defender portal → Devices → Initiate response action → Restart).

**Step 5 — Survey compliance posture**
Call `survey_compliance_posture`. One call returns the three device-compliance controls. Read:
- `sip` — System Integrity Protection (macOS) or Secure Boot (Windows). Most security agents require it, and a disabled SIP is why an agent refuses to start or runs degraded. **Not locally repairable** — re-enabling needs Recovery Mode and is IT-controlled, so escalate rather than attempting further repair. Report it prominently.
- `diskEncryption` — FileVault / BitLocker state and progress.
- `firewall` — the one control here with a local remedy (Step 8).

Any field may carry `status: "error"` when that one probe failed; the other two still stand.

**Step 6 — Turn the firewall back on**
`Condition:` only run if Step 5's `firewall.enabled` is false. Call `enable_firewall`. This is the one compliance failure with a local remedy: re-pushing policy does **not** fix a firewall the user switched off, because the policy is already assigned and applied — the device state simply diverged from it. Fixing it here also avoids a pointless Intune round-trip in Steps 7–8.

The tool cannot disable a firewall and takes no state parameter. On macOS it flips the global state only, leaving stealth mode and per-application rules alone; on Windows it enables all three profiles, since a compliance rule fails if any one is off. Say that in the rationale — a user who thinks their firewall rules are being rewritten will decline.

If the tool returns `enabled: false` with an admin-rights message, the privileged helper was unavailable: surface the escalation hint verbatim and continue.

**Step 7 — Check the device's MDM configuration**
`Condition:` only run if a fault **remains** that a policy re-delivery could plausibly fix — Step 1 found the agent stopped, Step 5 reported disk encryption disabled, or Step 6 could not re-enable the firewall. Note the word *remains*: a firewall Step 6 successfully re-enabled is fixed and must NOT pull the run into the MDM arm.

Call `c_mdm_diagnose_configuration` with `states: "compliance"` — this skill wants compliance policies (encryption, firewall, OS version, agent presence), not configuration profiles. It reads enrollment, locates the device in the tenant, and returns the per-policy states in one call. Every eligibility rule — reachable provider, readable serial, exactly one matching device, checked in within 7 days, at least one policy in `failed` — is enforced inside the tool, so do not re-derive them here.

A lost enrollment is itself the finding: it means IT cannot push policy updates, agent upgrades or remote reinstalls, and re-enrollment needs IT. Only `outcome: "failed-items"` continues. On anything else, skip Steps 8–9 and escalate with the tool's `message` — it is already written for the user. On `stale-checkin` lead with the check-in age: a device that fell off management is more useful to IT than any symptom.

On `failed-items`, name the specific failing policy from `failedItems` and match it to the fault — an unapproved system extension, a disk-encryption policy, a firewall policy, or an agent-deployment policy that never landed. Report it by name even if Step 8 is skipped; that is what makes the escalation actionable.

**Step 8 — Re-apply the device's configuration**
`Condition:` only run if Step 7 returned `reapplyWarranted: true` AND the failing policy matches the diagnosed fault.

Call `c_mdm_reapply_configuration`. State plainly in the rationale that this tells the device to check in and re-apply **all** its assigned configuration; it is not a targeted re-push, it creates and changes no policy, and it completes asynchronously after the tool returns. It cannot approve a system extension that IT has never authored — if no matching policy exists in Step 9, say so and escalate rather than syncing.

**Step 9 — Wait, then re-check whether the policy landed**
`Condition:` only run if Step 8 returned `status: "ok"`. That proves only that the MDM accepted the request — it is not evidence that the device re-applied anything. Call `wait_for_user_ack`:

```yaml
prompt: "I've asked Intune to re-send your device's configuration. That usually takes a minute or two. Tell me when to re-check."
options:
  - { id: "ready", label: "Ready — re-check now", kind: "primary" }
  - { id: "skip",  label: "Skip the re-check",    kind: "cancel" }
```

**Step 10 — Re-check the agent after the policy landed**
`Condition:` only run if Step 9 returned `ready`. Call `check_agent_process` with the agent from Step 1 and report the settled state. If it is still not running, the re-sync did not resolve it — escalate with the failing policy named in Step 9. Never describe the agent as repaired on the strength of Step 8 alone; on `skip` at Step 9, report the sync as initiated and unverified.

**Step 11 — Final report**
Summarise the agent's health across all dimensions checked:
- Process running (Step 1 + Step 4 post-restart re-check): yes/no
- System extension (Step 2 + Step 2b user approval): approved/pending/missing/n/a-windows
- Version (Step 1's `versions`): current/outdated
- Console connectivity (Step 1's `heartbeat`): reachable/unreachable/not-tested-custom-vendor
- Agent heartbeat (Step 1 + Step 4 post-restart re-check): healthy/stale/n/a
- Recent log errors (Step 3): clean / specific error categories
- FileVault (Step 5): enabled/disabled — if disabled, whether the user was given the self-service steps
- Firewall (Steps 8–6): was enabled / was off and re-enabled / was off and could not be re-enabled
- MDM enrollment (Step 7): enrolled/unenrolled
- Intune device record (Step 8): found/not-in-tenant/ambiguous-serial/not-checked
- Failing policy (Step 9): named policy, or none
- Re-sync (Step 8) + re-check (Steps 9–10): initiated-and-settled / initiated-unverified / skipped

Advise on any items that require IT intervention (SIP disabled, MDM unenrolled, expired enrollment certificate, tamper protection active, MDM-blocked system extension, missing system extension requiring reinstall via `software-reinstall`).

---

## Privilege handling — agent restart and tamper protection

Step 4 (`restart_process` of the security agent) is the only privileged operation in this skill. All enterprise security agents (CrowdStrike Falcon, SentinelOne, Microsoft Defender for Endpoint, Carbon Black, Cylance, Jamf Protect) run as **root** (macOS) or **SYSTEM** (Windows), so a user-space restart request requires elevated rights. The agent handles this in two modes:

**When the privileged helper daemon is available** (default — `HELPER_DAEMON_ENABLED=true` and helper installed): the agent routes the restart through the helper daemon and it completes silently for **all users — admin and non-admin alike**. The user sees the step succeed.

**When the helper is unavailable** (`HELPER_DAEMON_ENABLED=false`, helper not installed, or helper unreachable — `denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`) **OR when tamper protection blocks the restart even with admin rights**: the restart denies and the diagnostic continues to completion. In this fallback case, in the response:

1. **Do not present the denied step as a failure.** State plainly that restarting the agent could not be performed on this device and explain why (helper unavailable, non-admin user, or tamper protection blocking the call even for admins).
2. **Try the vendor's built-in user-space refresh first** — most enterprise agents expose a "Refresh connection" or "Reset" action in their menu-bar / system-tray UI that does NOT require admin and bypasses tamper protection:
   - CrowdStrike Falcon: menu-bar icon → "Refresh sensor connection"
   - SentinelOne: tray icon → "Reset agent"
   - Microsoft Defender: open Defender app → Settings → "Sync"
   - Jamf Protect: menu-bar icon → "Check in now"
   - Carbon Black: tray icon → "Send Status"
3. **Management-console restart** — when tamper protection is enabled (most enterprise deployments), even an admin restart will fail; the proper path is via the management console:
   - CrowdStrike: Falcon Console → Host Management → select host → Restart Sensor
   - SentinelOne: Management Console → Sentinels → select agent → Actions → Restart
   - Microsoft Defender: Microsoft 365 Defender portal → Devices → select device → "Initiate response action" → Restart
4. **Escalation packet** — the diagnostic from Steps 1–3 and 9–10 captures everything IT needs to triage without further back-and-forth: process state, SIP / Secure Boot status, system extension status, version, console reachability, heartbeat freshness, log error excerpts, FileVault status, and MDM enrollment. The end-of-run ticket includes all of this so a tier-1 helpdesk can pick up cleanly.

---

## Edge cases

- **Tamper protection** — most enterprise security agents have tamper protection that prevents the agent from being stopped, modified, or uninstalled without a management console token. If `restart_process` fails with a permissions error, tamper protection is active — do not attempt to work around it; escalate to IT who can issue a maintenance token
- **Agent reinstall vs repair** — if the agent process cannot be started after restart attempts and no blocking system issue is found, a reinstall is likely needed. Do not attempt to reinstall a security agent using the `software-reinstall` skill without IT approval — the installer must come from the management console to be properly enrolled. Advise the user to contact IT for a managed reinstall
- **Multiple agents conflict** — running two endpoint detection agents simultaneously (e.g. both CrowdStrike and SentinelOne) causes kernel-level conflicts and crashes. If `check_agent_process` detects more than one active EDR agent, report this to the user and escalate to IT — do not attempt to remove either agent without IT guidance
- **Apple Silicon vs Intel** — on Apple Silicon Macs, system extensions follow a different approval flow and some older security agents have separate ARM builds. If the agent is listed as installed but the system extension is absent, the installed version may be Intel-only running under Rosetta. Advise the user to check with IT for an Apple Silicon-native build
- **CrowdStrike sensor IDs** — each CrowdStrike installation has a unique sensor ID tied to the management console. If the agent was reinstalled outside of the console workflow, the new installation will have a different sensor ID and will appear as a new, unenrolled device. IT must decommission the old sensor ID and enroll the new one
- **Defender on macOS** — Microsoft Defender on macOS runs as `wdavdaemon` and uses a separate management channel from Windows Defender. `check_agent_logs` for Defender on macOS reads files from `/Library/Logs/Microsoft/mdatp/` rather than the Windows Event Log. Separately, `get_agent_version` on macOS invokes the `mdatp version` CLI to read the installed version
- **Compliance vs functionality** — an agent can be running and healthy on the device but still show as "out of compliance" in the IT dashboard if it has not checked in recently (e.g. the device was offline for 7+ days). After confirming the agent is running and console connectivity is restored, advise the user to allow 15–30 minutes for the compliance status to update in the dashboard
