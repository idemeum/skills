# Email not working

**Skill:** `email-repair` · **Risk:** high · **Steps:** 15

Diagnoses and repairs email client issues including account configuration, authentication/credential failures, index corruption, database errors, SMTP/IMAP connectivity failures, and permission problems.

## What it does, step by step

**Step 1.** Reads the email account's server settings and compares them against known-good provider values.
_read-only_ · `check_mail_account_config`

**Step 2.** Asks which email provider the affected account uses when no configuration is found.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 3.** Asks for the outgoing mail server address when the provider is a company or unlisted service.
_asks the user, conditional_ · `request_user_input`

**Step 4.** Tests whether the outgoing mail server can be reached and responds properly.
_read-only_ · `check_smtp_connectivity`

**Step 5.** Checks whether the mail server's security certificate has genuinely expired.
_read-only_ · `check_certificate_expiry`

**Step 6.** Checks whether the email client is frozen or overusing system resources.
_read-only_ · `get_top_consumers`

**Step 7.** Checks and, if needed, fixes file permission problems affecting Apple Mail.
_read-only, conditional_ · `check_mail_permissions`

**Step 8.** Asks the user to describe the exact symptom to decide which repair to run.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 9.** Checks whether outdated saved login credentials might be causing sign-in failures.
_deletes data, asks permission, preview first, conditional_ · `get_cached_credentials_count`, `repair_keychain`, `purge_cached_credentials`

**Step 11.** Rebuilds the mail index to fix slowness, wrong counts, or missing messages.
_deletes data, asks permission, preview first, conditional_ · `rebuild_mail_index`

**Step 12.** Repairs the Outlook data file to fix crashing or corruption issues.
_deletes data, asks permission, preview first, conditional_ · `repair_outlook_database`

**Step 13.** Asks whether email works now after the first repair attempt.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 14.** Resets the email client's preferences as a last-resort fix, keeping accounts intact.
_deletes data, asks permission, preview first, conditional_ · `reset_app_preferences`

**Step 15.** Asks whether email works now after resetting preferences, and prepares for escalation if not.
_asks the user, conditional_ · `wait_for_user_ack`

**Step 16.** Summarizes what was done, the results, and any recommendation to escalate to IT.
_no tools_

## Tools it may use

`check_mail_account_config`, `check_smtp_connectivity`, `check_certificate_expiry`, `get_top_consumers`, `check_mail_permissions`, `get_cached_credentials_count`, `repair_keychain`, `purge_cached_credentials`, `rebuild_mail_index`, `repair_outlook_database`, `reset_app_preferences`, `wait_for_user_ack`, `request_user_input`
