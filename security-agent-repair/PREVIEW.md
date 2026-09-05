# Security or endpoint agent not running

**Skill:** `security-agent-repair` · **Risk:** high · **Steps:** 13

Diagnoses and repairs endpoint security agent issues including stopped processes, outdated versions, unapproved system extensions, connectivity failures to management consoles, and compliance posture problems. Supports CrowdStrike Falcon, SentinelOne, Jamf Protect, Carbon Black, Cylance, and Microsoft Defender.

## What it does, step by step

**Step 1.** Detects installed security agents, checks their versions, running state, and last check-in with the management console.
_read-only_ · `survey_security_agent`

**Step 2.** Checks whether the security agent's system extension is approved and active on Mac devices.
_read-only_ · `check_system_extension`

**Step 2b.** Asks the user to approve the pending system extension in system settings and confirm once done.
_asks the user_ · `wait_for_user_ack`

**Step 3.** Reviews recent agent logs for authentication, network, extension, or tamper-protection errors.
_read-only_ · `check_agent_logs`

**Step 4.** Restarts the stopped security agent once no blocking issue is found.
_makes a change, asks permission_ · `restart_process`

**Step 4b.** Asks the user to try the vendor's built-in refresh option when a direct restart isn't possible.
_asks the user_ · `wait_for_user_ack`, `check_agent_process`

**Step 5.** Checks system integrity protection, disk encryption, and firewall status for compliance.
_read-only_ · `survey_compliance_posture`

**Step 6.** Turns the device's firewall back on if it was found disabled.
_makes a change, asks permission, preview first_ · `enable_firewall`

**Step 7.** Checks the device's management enrollment and which compliance policies are failing.
_read-only_ · `c_mdm_diagnose_configuration`

**Step 8.** Tells the device to check in and re-apply all its assigned configuration.
_makes a change, asks permission, preview first_ · `c_mdm_reapply_configuration`

**Step 9.** Asks the user to wait briefly, then confirms when ready to re-check the configuration.
_asks the user_ · `wait_for_user_ack`

**Step 10.** Re-checks whether the security agent is now running after the configuration update.
_read-only_ · `check_agent_process`

**Step 11.** Summarizes the agent's overall health and flags any issues needing IT follow-up.
_no tools_

## Tools it may use

`survey_security_agent`, `survey_compliance_posture`, `check_system_extension`, `check_agent_logs`, `check_agent_process`, `restart_process`, `enable_firewall`, `c_mdm_diagnose_configuration`, `c_mdm_reapply_configuration`, `wait_for_user_ack`
