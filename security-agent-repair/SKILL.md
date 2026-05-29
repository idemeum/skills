---
name: security-agent-repair
description: Diagnoses and repairs endpoint security agent issues including stopped processes, outdated versions, unapproved system extensions, connectivity failures to management consoles, and compliance posture problems. Supports CrowdStrike Falcon, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - check_agent_process
  - check_agent_heartbeat
  - check_sip_status
  - check_system_extension
  - get_agent_version
  - check_connectivity
  - check_agent_logs
  - restart_process
  - check_filevault_status
  - check_mdm_enrollment
  - wait_for_user_ack
metadata:
  prerequisites:
    before-corrective:
      - check_agent_process
      - check_sip_status
      - check_system_extension
      - get_agent_version
      - check_connectivity
      - check_agent_logs
  maxAggregateRisk: medium
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
  proactive-triggers:
    # Wave 2 Track B Phase 4 — Trigger 3 (MSP compliance-critical).
    # Direct customer-facing compliance alerts + SLA dollar impact for MSPs.
    - name: agent-not-heartbeating
      telemetry:
        tool: check_agent_heartbeat
        intervalMs: 600000       # 10 min — agent liveness is the most fast-moving Wave 2 signal
      condition: "healthy == false && ageSec >= 900"
      duration: 15m              # Hysteresis matches the 15-min threshold in the condition
      autofix: false
      severity: high
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

**Step 1 — Identify installed security agents**
Call `check_agent_process` with `agent: "auto"` to detect all known security agents and their running status. This establishes which agents are installed, which are running, and which have stopped. If no known agents are detected, end the run with: *"I couldn't detect a known security agent on this device. If you know your IT uses a custom or non-standard EDR, please contact IT directly — this skill supports CrowdStrike, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender."* The remaining Steps' `Condition:` clauses will all skip cleanly when no agent is detected.

**Step 2 — Check SIP and Secure Boot compliance**
Call `check_sip_status` to verify System Integrity Protection (macOS) or Secure Boot (Windows) is enabled. Most security agents require SIP to be enabled — if it is disabled, the agent may refuse to start or operate in a degraded mode. If SIP is disabled, escalate to IT immediately rather than attempting further repair — re-enabling SIP requires Recovery Mode and is an IT-controlled operation. Step 11's final report will surface this.

**Step 3 — Check system extension approval (macOS only)**
`Condition:` only run if platform is `darwin`. On Windows, `check_system_extension` falls back to checking services / Defender status — the macOS-specific approval flow does not apply, so skip Step 3b's user-approval ack on Windows.

Call `check_system_extension`. The tool accepts an optional `bundleId: string` to target a specific extension — omit it to list every registered extension, or pass the agent's bundle ID when targeting a specific agent identified in Step 1. Known bundle IDs:
- CrowdStrike Falcon — `com.crowdstrike.falcon.Agent`
- SentinelOne — `com.sentinelone.agent-control`
- Jamf Protect — `com.jamf.protect.daemon`
- Microsoft Defender — `com.microsoft.wdav.epsext`
- Carbon Black — `com.carbonblack.es-extension`
- Cylance — `com.blackberry.cylance-es-loader`

An unapproved or "waiting for user" extension is one of the most common causes of agents appearing installed but non-functional. Step 3b's ack will gate the user's approval action.

**Step 3b — Wait for user to approve the system extension (macOS only)**
`Condition:` only run if (a) platform is `darwin` AND (b) Step 3 returned at least one extension with status `waiting-for-user` (or vendor-equivalent "pending approval"). Call `wait_for_user_ack`:

```yaml
prompt: "Your security agent's system extension needs approval. Open System Settings → Privacy & Security → scroll to the Security section → click Allow next to the extension notification. The agent will activate within 30–60 seconds after approval. Let me know when you've done it."
options:
  - { id: "approved",        label: "I approved it",                  kind: "primary" }
  - { id: "blocked-by-mdm",  label: "It's blocked by MDM",            kind: "secondary" }
  - { id: "not-there",       label: "I don't see the notification",   kind: "secondary" }
  - { id: "skip",            label: "Skip — diagnose anyway",         kind: "cancel" }
```

On `approved`: proceed to Step 4. On `blocked-by-mdm`: end the run with IT escalation (MDM policy needed; user cannot approve MDM-blocked extensions through System Settings). On `not-there`: end the run with reinstall recommendation (`software-reinstall` skill — IT-managed). On `skip`: proceed to Step 4 but the agent will remain non-functional.

**Step 4 — Check agent version**
Call `get_agent_version` with `agent` set to the identified agent from Step 1. The `agent` parameter is **required** and must be one of: `"crowdstrike"`, `"sentinelone"`, `"jamf"`, `"carbonblack"`, `"cylance"`, `"defender"`. Unlike `check_agent_process`, this tool does not accept `"auto"` — pick one specific agent per call. If Step 1 detected multiple agents, call `get_agent_version` once per agent.

An outdated version may be intentionally stopped by the management console (some platforms auto-quarantine agents below a minimum version). Compare the installed version against what IT has specified as the required minimum, if known.

**Step 5 — Check console connectivity**
`Condition:` only run if Step 1's detected agent is one of the six known vendors with a default console hostname. Skip silently for exotic / unknown / custom-console vendors — Step 6's heartbeat check provides a vendor-agnostic console-reporting signal that does NOT require a hostname. Surface "Console reachability not tested (custom or unknown vendor)" in the Step 11 final report when skipped.

Call `check_connectivity` with the vendor's default console hostname as a target:
- CrowdStrike → `falcon.crowdstrike.com`
- SentinelOne → `usea1.sentinelone.net`
- Jamf Protect → `radar.jamf.com`
- Carbon Black → `cwd.conferdeploy.net`
- Cylance → `protect-na.cylance.com`
- Microsoft Defender → `winatp-gw-cus.microsoft.com`

If the console is unreachable at the TCP layer, the agent may be running but unable to receive policy updates or report telemetry — IT will see it as offline.

**Step 6 — Check agent heartbeat to console**
`Condition:` only run if Step 1's detected agent is one of the six known vendors (heartbeat tool supports those vendors). Skip silently for exotic vendors.

Call `check_agent_heartbeat`. Returns `healthy: bool` and `ageSec` (seconds since last successful console check-in). A `healthy: false` with `ageSec > 900` (15 min) indicates the agent process may be running but is not actually reporting to the console — a stale heartbeat is what IT sees as "agent offline" in the dashboard. Complements Step 5's TCP-level reachability with the application-level "is it actually talking?" signal. Step 8's restart verification uses this same tool to confirm the agent recovered.

**Step 7 — Review agent logs**
Call `check_agent_logs` for the affected agent with `errorOnly: true` to surface recent errors and warnings. Look for:
- Authentication or certificate errors → the agent's enrollment certificate may have expired
- Network timeout errors → connectivity issue to management console (Step 5 / Step 6 already surfaced this)
- Extension or kernel errors → system extension problem (Step 3 / 3b already surfaced this)
- "Tamper protection" or "policy violation" messages → IT has locked the agent configuration; escalate to IT

**Step 8 — Restart the agent**
`Condition:` only run if (a) Step 1 showed the agent process is `running: false` AND (b) Steps 2–7 surfaced no blocking issue (SIP enabled, extension approved if applicable, version OK, no tamper-protection log entries). Skip if the agent is already running (no need to restart) or if a blocking issue was found (restart won't help until the blocker is resolved).

Call `restart_process` with `name` from Step 1's `detectedAgents[].processName` (`inputsFrom: [{ step: 1, field: "detectedAgents" }]`) — e.g. `"com.crowdstrike.falcon.Agent"`, `"SentinelAgent"`, `"wdavdaemon"`. The tool does NOT support dry-run (`supportsDryRun: false`). The G4 consent gate handles user confirmation automatically (`requiresConsent: true`, `destructive: true`, `riskLevel: medium`).

**Privilege reality.** All enterprise security agents run as **root** (macOS) or **SYSTEM** (Windows). When a non-admin user attempts to restart one without the helper daemon, the OS rejects with EPERM / "Access denied". The privileged helper daemon (default — `HELPER_DAEMON_ENABLED=true`) routes `restart_process` for the agent and completes silently for **all users — admin and non-admin alike**. **Tamper protection** is a separate blocker — even an admin call fails if the agent's tamper protection is enabled (most enterprise deployments); the proper path is via the management console (Falcon Console → Host Management → Restart Sensor; Microsoft 365 Defender portal). Step 8b's ack surfaces the vendor-UI refresh fallback when the OS call denies.

If the restart returns successfully, the agent re-verifies health: re-call `check_agent_process` (with the same `agent` name, not `"auto"`) to confirm the process is now running, then re-call `check_agent_heartbeat` to confirm the agent is reporting to console. These two re-checks are the agent's verification — no user-side test is needed.

**Step 8b — Wait for user to try vendor-UI refresh (fallback)**
`Condition:` only run if Step 8 ran AND denied (`denyCategory: "helper-unavailable"` / `"helper-error"` / `"scope-boundary"`) OR returned EPERM / tamper-protection error. Call `wait_for_user_ack`:

```yaml
prompt: "I couldn't restart the agent directly — most enterprise agents block restart from user space (tamper protection) or need admin rights the agent doesn't have. Most vendors have a built-in 'refresh' action that works WITHOUT admin: CrowdStrike Falcon → menu-bar icon → 'Refresh sensor connection'; SentinelOne → tray icon → 'Reset agent'; Microsoft Defender → open Defender → Settings → 'Sync'; Jamf Protect → menu-bar icon → 'Check in now'; Carbon Black → tray icon → 'Send Status'. Try it and let me know."
options:
  - { id: "refreshed",          label: "I ran the vendor refresh",      kind: "primary" }
  - { id: "no-option-available", label: "Vendor has no refresh option",  kind: "secondary" }
  - { id: "skip",               label: "Skip — escalate to IT",         kind: "cancel" }
```

On `refreshed`: re-call `check_agent_heartbeat` to confirm the agent recovered post-refresh. On `no-option-available` / `skip`: end the run with management-console escalation advice (Falcon Console → Host Management → Restart Sensor; Microsoft 365 Defender portal → Devices → Initiate response action → Restart).

**Step 9 — Check compliance posture: FileVault**
Call `check_filevault_status` to verify disk encryption is active — most security platforms require FileVault (macOS) or BitLocker (Windows) as part of their compliance baseline. A non-encrypted machine will show as out of compliance in the management console even if the agent itself is running correctly.

**Step 10 — Check MDM enrollment**
Call `check_mdm_enrollment` to verify the device is still enrolled in MDM (Jamf, Intune, etc.). A lost MDM enrollment means IT cannot push policy updates, agent upgrades, or remotely trigger reinstalls. If enrollment is lost, escalate to IT — re-enrollment typically requires IT intervention.

**Step 11 — Final report**
Summarise the agent's health across all dimensions checked:
- Process running (Step 1 + Step 8 post-restart re-check): yes/no
- System extension (Step 3 + Step 3b user approval): approved/pending/missing/n/a-windows
- Version (Step 4): current/outdated
- Console connectivity (Step 5): reachable/unreachable/not-tested-custom-vendor
- Agent heartbeat (Step 6 + Step 8 post-restart re-check): healthy/stale/n/a
- Recent log errors (Step 7): clean / specific error categories
- FileVault (Step 9): enabled/disabled
- MDM enrollment (Step 10): enrolled/unenrolled

Advise on any items that require IT intervention (SIP disabled, MDM unenrolled, expired enrollment certificate, tamper protection active, MDM-blocked system extension, missing system extension requiring reinstall via `software-reinstall`).

---

## Privilege handling — agent restart and tamper protection

Step 8 (`restart_process` of the security agent) is the only privileged operation in this skill. All enterprise security agents (CrowdStrike Falcon, SentinelOne, Microsoft Defender for Endpoint, Carbon Black, Cylance, Jamf Protect) run as **root** (macOS) or **SYSTEM** (Windows), so a user-space restart request requires elevated rights. The agent handles this in two modes:

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
4. **Escalation packet** — the diagnostic from Steps 1–7 and 9–10 captures everything IT needs to triage without further back-and-forth: process state, SIP / Secure Boot status, system extension status, version, console reachability, heartbeat freshness, log error excerpts, FileVault status, and MDM enrollment. The end-of-run ticket includes all of this so a tier-1 helpdesk can pick up cleanly.

---

## Edge cases

- **Tamper protection** — most enterprise security agents have tamper protection that prevents the agent from being stopped, modified, or uninstalled without a management console token. If `restart_process` fails with a permissions error, tamper protection is active — do not attempt to work around it; escalate to IT who can issue a maintenance token
- **Agent reinstall vs repair** — if the agent process cannot be started after restart attempts and no blocking system issue is found, a reinstall is likely needed. Do not attempt to reinstall a security agent using the `software-reinstall` skill without IT approval — the installer must come from the management console to be properly enrolled. Advise the user to contact IT for a managed reinstall
- **Multiple agents conflict** — running two endpoint detection agents simultaneously (e.g. both CrowdStrike and SentinelOne) causes kernel-level conflicts and crashes. If `check_agent_process` detects more than one active EDR agent, report this to the user and escalate to IT — do not attempt to remove either agent without IT guidance
- **Apple Silicon vs Intel** — on Apple Silicon Macs, system extensions follow a different approval flow and some older security agents have separate ARM builds. If the agent is listed as installed but the system extension is absent, the installed version may be Intel-only running under Rosetta. Advise the user to check with IT for an Apple Silicon-native build
- **CrowdStrike sensor IDs** — each CrowdStrike installation has a unique sensor ID tied to the management console. If the agent was reinstalled outside of the console workflow, the new installation will have a different sensor ID and will appear as a new, unenrolled device. IT must decommission the old sensor ID and enroll the new one
- **Defender on macOS** — Microsoft Defender on macOS runs as `wdavdaemon` and uses a separate management channel from Windows Defender. `check_agent_logs` for Defender on macOS reads files from `/Library/Logs/Microsoft/mdatp/` rather than the Windows Event Log. Separately, `get_agent_version` on macOS invokes the `mdatp version` CLI to read the installed version
- **Compliance vs functionality** — an agent can be running and healthy on the device but still show as "out of compliance" in the IT dashboard if it has not checked in recently (e.g. the device was offline for 7+ days). After confirming the agent is running and console connectivity is restored, advise the user to allow 15–30 minutes for the compliance status to update in the dashboard
