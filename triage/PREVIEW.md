# Submit issue to IT helpdesk

**Skill:** `triage` · **Risk:** low · **Steps:** 9

Collects structured intake information when no specific skill matches the user's IT request. Presents the issue classified into category, urgency, affected system, and symptoms for user review. Ticket submission is handled by the existing post-execution createTicket() path.

## What it does, step by step

**Step 1.** Runs the read-only diagnostic and relevant follow-up checks for the selected category.
_read-only_ · `check_connectivity`, `list_installed_apps`, `list_usb_devices`, `get_processes`, `check_mail_account_config`, `list_printers`, `get_top_consumers`, `check_firewall_status`

**Step 2.** Checks whether the Entra account is enabled or locked.
_read-only_ · `c_entra_get_user_info`

**Step 3.** Checks which MFA methods are registered for the Entra account.
_read-only_ · `c_entra_get_mfa_status`

**Step 4.** Checks Entra sign-in logs only for reported sign-in failures.
_read-only, conditional_ · `c_entra_get_sign_in_logs`

**Step 5.** Checks whether the Okta account is enabled or locked.
_read-only_ · `c_okta_get_user`

**Step 6.** Checks which MFA methods are registered for the Okta account.
_read-only_ · `c_okta_get_mfa_status`

**Step 7.** Checks the device's MDM compliance status and reports any failed items.
_read-only_ · `c_mdm_diagnose_configuration`

**Step 8.** Checks the device in RMM for the selected category's relevant monitoring areas.
_read-only_ · `c_rmm_diagnose_device`

**Step 9.** Records the triage summary and category for the user to review before submission.
_asks the user, conditional_ · `c_record_triage`

## Tools it may use

`check_connectivity`, `get_top_consumers`, `list_installed_apps`, `list_usb_devices`, `check_firewall_status`, `check_mail_account_config`, `list_printers`, `get_processes`, `c_entra_get_user_info`, `c_entra_get_mfa_status`, `c_entra_get_sign_in_logs`, `c_okta_get_user`, `c_okta_get_mfa_status`, `c_mdm_diagnose_configuration`, `c_rmm_diagnose_device`, `c_record_triage`
