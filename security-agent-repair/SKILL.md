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
    order: 7
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
Call `check_agent_process` with `agent: "auto"` to detect all known security agents and their running status. This establishes which agents are installed, which are running, and which have stopped. If no known agents are detected, report this to the user and ask them to confirm which product IT uses.

**Step 2 — Check SIP and Secure Boot compliance**
Call `check_sip_status` to verify System Integrity Protection (macOS) or Secure Boot (Windows) is enabled. Most security agents require SIP to be enabled — if it is disabled, the agent may refuse to start or operate in a degraded mode. If SIP is disabled, escalate to IT immediately rather than attempting further repair — re-enabling SIP requires Recovery Mode and is an IT-controlled operation.

**Step 3 — Check system extension approval (macOS only)**
Call `check_system_extension` for the affected agent. On macOS, security agents use system extensions that must be explicitly approved by the user in System Settings → Privacy & Security. An unapproved or "waiting for user" extension is one of the most common causes of agents appearing installed but non-functional.

The tool accepts an optional `bundleId: string` to target a specific extension — omit it to list every registered extension (useful when you want to see the complete picture), or pass the agent's bundle ID when you want to check one specific agent identified in Step 1. Known bundle IDs:
- CrowdStrike Falcon — `com.crowdstrike.falcon.Agent`
- SentinelOne — `com.sentinelone.agent-control`
- Jamf Protect — `com.jamf.protect.daemon`
- Microsoft Defender — `com.microsoft.wdav.epsext`
- Carbon Black — `com.carbonblack.es-extension`
- Cylance — `com.blackberry.cylance-es-loader`

On Windows, the tool falls back to checking services / Defender status — no `bundleId` is needed there.

If an extension requires approval, guide the user:
1. Open System Settings → Privacy & Security
2. Scroll to the Security section
3. Click "Allow" next to the extension notification
4. The agent will activate within 30–60 seconds after approval

**Step 4 — Check agent version**
Call `get_agent_version` with `agent` set to the identified agent from Step 1. The `agent` parameter is **required** and must be one of: `"crowdstrike"`, `"sentinelone"`, `"jamf"`, `"carbonblack"`, `"cylance"`, `"defender"`. Unlike `check_agent_process`, this tool does not accept `"auto"` — you must pick one specific agent per call. If Step 1 detected multiple agents, call `get_agent_version` once per agent.

An outdated version may be intentionally stopped by the management console (some platforms auto-quarantine agents below a minimum version). Compare the installed version against what IT has specified as the required minimum, if known.

**Step 5 — Check agent connectivity**
Call `check_connectivity` with the management console hostname as a target (ask the user for it, or use known defaults: falcon.crowdstrike.com for CrowdStrike, usea1.sentinelone.net for SentinelOne). If the console is unreachable, the agent may be running but unable to receive policy updates or report telemetry — IT will see it as offline even though it is technically running.

**Step 6 — Review agent logs**
Call `check_agent_logs` for the affected agent with `errorOnly: true` to surface recent errors and warnings. Look for:
- Authentication or certificate errors → the agent's enrollment certificate may have expired
- Network timeout errors → connectivity issue to management console (addressed in Step 5)
- Extension or kernel errors → system extension problem (addressed in Step 3)
- "Tamper protection" or "policy violation" messages → IT has locked the agent configuration; escalate to IT

**Step 7 — Restart the agent**
If the agent process is stopped and no blocking issue was found in Steps 2–6, call `restart_process` with the agent's process name (take it from the `processName` field of the matching entry in Step 1's `detectedAgents` array — e.g. `"com.crowdstrike.falcon.Agent"`, `"SentinelAgent"`, `"wdavdaemon"`).

The tool does NOT support dry-run (`supportsDryRun: false` — only accepts `name`, `pid`, `launchPath`). The G4 consent gate handles user confirmation automatically (`requiresConsent: true`, `destructive: true`, `riskLevel: medium`).

**Privilege reality.** All enterprise security agents (CrowdStrike Falcon, SentinelOne, Microsoft Defender for Endpoint, Carbon Black, Cylance, Jamf Protect) run as **root** (macOS) or **SYSTEM** (Windows). When a non-admin user attempts to restart one via this step, the OS rejects the call with EPERM (macOS) or "Access denied" (Windows). This is the OS enforcing the privilege boundary — not a tool malfunction.

If the restart fails with a permission error, do NOT treat it as a failure of the diagnostic. Instead:

1. State plainly that restarting the agent requires administrator privileges and the agent could not run it.
2. **Self-service path** — most enterprise agents have a built-in "Refresh connection" or "Reset" action in their menu-bar / system-tray UI that does NOT require admin. Check for this first:
   - CrowdStrike Falcon: menu-bar icon → "Refresh sensor connection"
   - SentinelOne: tray icon → "Reset agent"
   - Microsoft Defender: open Defender app → Settings → "Sync"
3. **Tamper protection** — even an admin restart may fail if the agent's tamper protection is enabled (most enterprise deployments). The proper repair path is via the management console (Falcon Console → Host Management → Restart Sensor; Microsoft 365 Defender portal). Surface this in the escalation note.
4. **Escalation packet** — the diagnostic from Steps 1–6, 8–9 captures everything IT needs to triage without further back-and-forth: process state, SIP, system extension status, version, console reachability, log error excerpts, FileVault state, MDM enrollment. The end-of-run ticket includes all of this.

If the restart returns successfully (admin user or non-tamper-protected agent), call `check_agent_process` again (with the same `agent` name, not `"auto"`) to verify the process is now running.

**Step 8 — Check compliance posture**
Call `check_filevault_status` to verify disk encryption is active — most security platforms require FileVault (macOS) or BitLocker (Windows) as part of their compliance baseline. A non-encrypted machine will show as out of compliance in the management console even if the agent itself is running correctly.

**Step 9 — Check MDM enrollment**
Call `check_mdm_enrollment` to verify the device is still enrolled in MDM (Jamf, Intune, etc.). A lost MDM enrollment means IT cannot push policy updates, agent upgrades, or remotely trigger reinstalls. If enrollment is lost, escalate to IT — re-enrollment typically requires IT intervention.

**Step 10 — Final report**
Summarise the agent's health across all dimensions checked:
- Process running: yes/no
- System extension: approved/pending/missing
- Version: current/outdated
- Console connectivity: reachable/unreachable
- FileVault: enabled/disabled
- MDM: enrolled/unenrolled

Advise on any items that require IT intervention (SIP disabled, MDM unenrolled, expired enrollment certificate, tamper protection active).

---

## Privilege handling — agent restart and tamper protection

Step 7 (`restart_process` of the security agent) is the only privileged operation in this skill. All enterprise security agents (CrowdStrike Falcon, SentinelOne, Microsoft Defender for Endpoint, Carbon Black, Cylance, Jamf Protect) run as **root** (macOS) or **SYSTEM** (Windows), so a user-space restart request requires elevated rights. The agent handles this in two modes:

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
4. **Escalation packet** — the diagnostic from Steps 1–6 and 8–9 captures everything IT needs to triage without further back-and-forth: process state, SIP / Secure Boot status, system extension status, version, console reachability, log error excerpts, FileVault status, and MDM enrollment. The end-of-run ticket includes all of this so a tier-1 helpdesk can pick up cleanly.

---

## Edge cases

- **Tamper protection** — most enterprise security agents have tamper protection that prevents the agent from being stopped, modified, or uninstalled without a management console token. If `restart_process` fails with a permissions error, tamper protection is active — do not attempt to work around it; escalate to IT who can issue a maintenance token
- **Agent reinstall vs repair** — if the agent process cannot be started after restart attempts and no blocking system issue is found, a reinstall is likely needed. Do not attempt to reinstall a security agent using the `software-reinstall` skill without IT approval — the installer must come from the management console to be properly enrolled. Advise the user to contact IT for a managed reinstall
- **Multiple agents conflict** — running two endpoint detection agents simultaneously (e.g. both CrowdStrike and SentinelOne) causes kernel-level conflicts and crashes. If `check_agent_process` detects more than one active EDR agent, report this to the user and escalate to IT — do not attempt to remove either agent without IT guidance
- **Apple Silicon vs Intel** — on Apple Silicon Macs, system extensions follow a different approval flow and some older security agents have separate ARM builds. If the agent is listed as installed but the system extension is absent, the installed version may be Intel-only running under Rosetta. Advise the user to check with IT for an Apple Silicon-native build
- **CrowdStrike sensor IDs** — each CrowdStrike installation has a unique sensor ID tied to the management console. If the agent was reinstalled outside of the console workflow, the new installation will have a different sensor ID and will appear as a new, unenrolled device. IT must decommission the old sensor ID and enroll the new one
- **Defender on macOS** — Microsoft Defender on macOS runs as `wdavdaemon` and uses a separate management channel from Windows Defender. `check_agent_logs` for Defender on macOS reads files from `/Library/Logs/Microsoft/mdatp/` rather than the Windows Event Log. Separately, `get_agent_version` on macOS invokes the `mdatp version` CLI to read the installed version
- **Compliance vs functionality** — an agent can be running and healthy on the device but still show as "out of compliance" in the IT dashboard if it has not checked in recently (e.g. the device was offline for 7+ days). After confirming the agent is running and console connectivity is restored, advise the user to allow 15–30 minutes for the compliance status to update in the dashboard
