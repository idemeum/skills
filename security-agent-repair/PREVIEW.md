# Security or endpoint agent not running

**Skill:** `security-agent-repair` · **Risk:** medium · **Steps:** 13

Diagnoses and repairs endpoint security agent issues including stopped processes, outdated versions, unapproved system extensions, connectivity failures to management consoles, and compliance posture problems. Supports CrowdStrike Falcon, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender.

## What it does, step by step

**Step 1.** Detects which security agents are installed and whether each is currently running.
_read-only_ · `check_agent_process`

**Step 2.** Checks whether required system protection settings are enabled for the agent to function.
_read-only_ · `check_sip_status`

**Step 3.** Checks whether the security agent's system extension is approved and active on Mac devices.
_read-only_ · `check_system_extension`

**Step 3b.** Asks the user to approve the pending system extension and confirms once it's done.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Checks whether the installed agent version meets the required minimum version.
_read-only_ · `get_agent_version`

**Step 5.** Checks whether the device can reach the security agent's management console.
_read-only_ · `check_connectivity`

**Step 6.** Checks whether the agent is actively checking in with its management console.
_read-only_ · `check_agent_heartbeat`

**Step 7.** Reviews recent agent error logs to identify certificate, network, extension, or policy problems.
_read-only_ · `check_agent_logs`

**Step 8.** Restarts the stopped security agent after confirming no blocking issues exist.
_deletes data, asks permission_ · `restart_process`, `check_agent_process`, `check_agent_heartbeat`

**Step 8b.** Asks the user to try the vendor's built-in refresh option if restart isn't possible.
_asks the user_ · `wait_for_user_ack`, `check_agent_heartbeat`

**Step 9.** Checks whether disk encryption is enabled, as required for compliance.
_read-only_ · `check_filevault_status`

**Step 10.** Checks whether the device is still enrolled in device management.
_read-only_ · `check_mdm_enrollment`

**Step 11.** Summarizes the agent's overall health and flags any issues needing IT attention.
_no tools_

## Tools it may use

`check_agent_process`, `check_agent_heartbeat`, `check_sip_status`, `check_system_extension`, `get_agent_version`, `check_connectivity`, `check_agent_logs`, `restart_process`, `check_filevault_status`, `check_mdm_enrollment`, `wait_for_user_ack`
