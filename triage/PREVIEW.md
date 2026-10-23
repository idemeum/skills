# Submit issue to IT helpdesk

**Skill:** `triage` · **Risk:** low · **Steps:** 8

Collects structured intake information when no specific skill matches the user's IT request. Presents the issue classified into category, urgency, affected system, and symptoms for user review. Ticket submission is handled by the existing post-execution createTicket() path.

## What it does, step by step

**Step 1.** Runs the relevant diagnostic for the chosen category.
_read-only_ · `check_connectivity`, `list_installed_apps`, `list_usb_devices`, `get_processes`, `check_mail_account_config`, `list_printers`, `get_top_consumers`, `check_firewall_status`

**Step 2.** Checks whether the Entra account is enabled or locked.
_read-only_ · `c_entra_get_user_info`

**Step 3.** Checks Entra MFA methods registered for the account.
_read-only_ · `c_entra_get_mfa_status`

**Step 4.** Checks Entra sign-in logs only when the problem is failing sign-ins.
_read-only, conditional_ · `c_entra_get_sign_in_logs`

**Step 5.** Checks whether the Okta account is enabled or locked.
_read-only_ · `c_okta_get_user`

**Step 6.** Checks Okta MFA methods registered for the account.
_read-only_ · `c_okta_get_mfa_status`

**Step 7.** Checks device compliance in Intune or Jamf and reports failed items that can block VPN or corporate Wi-Fi.
_read-only_ · `c_mdm_diagnose_configuration`

**Step 8.** Records the triage summary for the user to review before anything is sent to IT.
_asks the user, conditional_ · `c_record_triage`

## Tools it may use

`check_connectivity`, `get_top_consumers`, `list_installed_apps`, `list_usb_devices`, `check_firewall_status`, `check_mail_account_config`, `list_printers`, `get_processes`, `c_entra_get_user_info`, `c_entra_get_mfa_status`, `c_entra_get_sign_in_logs`, `c_okta_get_user`, `c_okta_get_mfa_status`, `c_mdm_diagnose_configuration`, `c_record_triage`
