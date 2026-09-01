# Security or endpoint agent not running

**Skill:** `security-agent-repair` · **Risk:** high · **Steps:** 20

Diagnoses and repairs endpoint security agent issues including stopped processes, outdated versions, unapproved system extensions, connectivity failures to management consoles, and compliance posture problems. Supports CrowdStrike Falcon, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender.

## What it does, step by step

**Step 1.** Detects which security agents are installed and whether each is currently running.
_read-only_ · `check_agent_process`

**Step 2.** Checks whether System Integrity Protection or Secure Boot is enabled, since agents need it active.
_read-only_ · `check_sip_status`

**Step 3.** Checks whether the security agent's system extension is approved and active.
_read-only_ · `check_system_extension`

**Step 3b.** Asks the user to approve the pending system extension and confirms once it's done.
_asks the user_ · `wait_for_user_ack`

**Step 4.** Checks whether the installed agent version meets the required minimum.
_read-only_ · `get_agent_version`

**Step 5.** Tests whether the device can reach the security agent's management console.
_read-only_ · `check_connectivity`

**Step 6.** Checks whether the agent is actively checking in with its management console.
_read-only_ · `check_agent_heartbeat`

**Step 7.** Reviews recent agent logs for authentication, network, extension, or tamper-related errors.
_read-only_ · `check_agent_logs`

**Step 8.** Restarts the stopped security agent process after confirming no blocking issues remain.
_makes a change, asks permission_ · `restart_process`, `check_agent_process`, `check_agent_heartbeat`

**Step 8b.** Asks the user to try the vendor's built-in refresh option and checks if it worked.
_asks the user_ · `wait_for_user_ack`, `check_agent_heartbeat`

**Step 9.** Checks whether disk encryption is enabled and guides the user to turn it on if not.
_read-only_ · `check_filevault_status`

**Step 10.** Checks whether the device firewall is currently enabled.
_read-only_ · `check_firewall_status`

**Step 11.** Turns the firewall back on if it was found disabled.
_makes a change, asks permission, preview first_ · `enable_firewall`

**Step 12.** Checks whether the device is properly enrolled in device management.
_read-only, conditional_ · `check_mdm_enrollment`

**Step 13.** Looks up the device's record in Intune to investigate a remaining policy issue.
_read-only, conditional_ · `c_intune_find_device`

**Step 14.** Identifies which specific management policy is failing and matches it to the problem found.
_read-only_ · `c_intune_get_compliance_states`

**Step 15.** Tells the device to re-check in and reapply its assigned configuration.
_makes a change, asks permission, preview first_ · `c_intune_sync_device`

**Step 16.** Waits for the user's go-ahead before re-checking whether the policy update took effect.
_asks the user_ · `wait_for_user_ack`

**Step 17.** Rechecks the agent's status after the policy update to confirm whether it's fixed.
_read-only_ · `check_agent_process`

**Step 18.** Summarizes the agent's overall health and flags any issues needing IT follow-up.
_no tools_

## Tools it may use

`check_agent_process`, `check_agent_heartbeat`, `check_sip_status`, `check_system_extension`, `get_agent_version`, `check_connectivity`, `check_agent_logs`, `restart_process`, `check_filevault_status`, `check_firewall_status`, `enable_firewall`, `check_mdm_enrollment`, `c_intune_find_device`, `c_intune_get_compliance_states`, `c_intune_sync_device`, `wait_for_user_ack`
