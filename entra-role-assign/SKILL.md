---
name: entra-role-assign
description: Assigns a built-in Microsoft Entra ID directory role (e.g. Helpdesk Administrator, User Administrator, Global Reader) to a user, granting tenant-wide permissions associated with that role. Use when the user says "give this person the Helpdesk Administrator role in Entra", "assign a directory role in Azure AD", "make this user a Global Reader", or similar Entra role-assignment requests.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - request_user_input
  - c_entra_get_user_info
  - c_entra_find_role
  - wait_for_user_ack
  - c_entra_get_role_assignments
  - c_entra_assign_role
metadata:
  maxAggregateRisk: high
  userLabel: "Assign an Entra directory role"
  examples:
    - "assign the Global Reader role to this user in Entra"
    - "make this user a Helpdesk Administrator in Azure AD"
    - "grant tenant-wide User Administrator role in Microsoft Entra"
    - "this employee needs the Exchange Administrator directory role assigned"
    - "escalate this account to a built-in Entra admin role"
    - "assign an Azure AD directory role for a new IT support hire"
  pill:
    label: Assign Entra Role
    goal: I need a built-in Microsoft Entra directory role assigned to a user so they get the tenant-wide permissions that role grants
    icon: UserCog
    iconClass: text-indigo-500
    order: 25
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
---

## When to use

Use this skill to assign a built-in Microsoft Entra ID directory role (Global Reader, Helpdesk Administrator, User Administrator, Exchange Administrator, etc.) to a user, granting the tenant-wide permissions that role carries.

Do NOT use for Okta or Google role/permission changes — those require different admin APIs. Do NOT use for app or group access requests (`entra-access-request`) or licence assignment (`entra-license-assign`) — those grant different, narrower kinds of access. Do NOT use for MFA (`entra-mfa-reset`), password (`entra-password-reset`), or lockout (`entra-account-unlock`) issues. Directory roles are tenant-wide and privileged — never assign one as a substitute for a narrower access or licence request.

---

## Steps

**Step 1 — Verify user account**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; role assignment can proceed but the user cannot use it until re-enabled
- On success, note `displayName` for messaging

**Step 2 — Capture the requested role**

Call `request_user_input` asking which built-in Entra directory role to assign (e.g. "Helpdesk Administrator", "Global Reader"). Explain this grants tenant-wide permissions, not access to a single app or group.

**Step 3 — Resolve the role**

Call `c_entra_find_role` with the name from Step 2.

- No matches → tell the user no built-in role matched that name; ask them to check the exact role name and retry
- One match → use it directly, skip Step 4
- Multiple matches → proceed to Step 4 to disambiguate

**Step 4 — Disambiguate multiple matches**

Only when Step 3 returned more than one match. Call `wait_for_user_ack` presenting up to 3 matching role names plus a "None of these" option (max 4 total) and let the user pick.

**Step 5 — Check current role assignments**

Call `c_entra_get_role_assignments`.

If the resolved `roleDefinitionId` from Step 3 or Step 4 is already present, tell the user the role is already assigned — this would be a no-op — and stop.

**Step 6 — Confirm the assignment**

Use `wait_for_user_ack` to confirm: "Assign the {role name} role to {displayName} ({upn})? This grants tenant-wide permissions for this role." Options: Yes / Cancel.

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 7 — Execute the assignment**

Call `c_entra_assign_role`.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 8 — Verify the assignment**

Call `c_entra_get_role_assignments` again to confirm the new `roleDefinitionId` now appears in the user's role list.

**Step 9 — Guide the user**

Tell the user:
- The role has been assigned to {displayName} and is effective immediately, though some Microsoft 365 services may take a few minutes to reflect the new permissions
- Directory roles are tenant-wide — remind them to review assignments periodically and remove roles no longer needed
- If the user also needs app/group access or a licence, mention `entra-access-request` or `entra-license-assign` as separate follow-ups

---

## Edge cases

- **Role already assigned:** Step 5 catches this — do not call the corrective; tell the user it's already in place.
- **No matching role name:** Step 3 — a typo or non-built-in role name will return no matches; ask the user to confirm the exact display name.
- **Multiple role matches:** Step 4 caps the picker at 3 results plus a "None of these" escape to respect the 4-option limit.
- **Account disabled:** the assignment can still proceed, but the user cannot exercise the role's permissions until the account is re-enabled.
- **High-privilege roles (Global Administrator, etc.):** treat with extra caution — reiterate the tenant-wide scope in Step 6's confirmation wording.