---
name: entra-role-assign
description: Assigns a Microsoft Entra ID built-in directory role (e.g. Global Reader, User Administrator, Helpdesk Administrator) to a user, granting them the tenant-wide permissions associated with that role. Use when an admin needs to grant a directory-level administrative role in Entra ID/Azure AD, not application access or licensing.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - request_user_input
  - wait_for_user_ack
  - c_entra_get_user_info
  - c_entra_find_role
  - c_entra_get_role_assignments
  - c_entra_assign_role
metadata:
  maxAggregateRisk: high
  userLabel: "Assign an Entra directory role"
  examples:
    - "assign the Global Reader role to a user in Entra"
    - "grant User Administrator role in Azure AD"
    - "user needs Helpdesk Administrator role for Entra ID"
    - "assign a built-in directory role in Microsoft Entra"
    - "grant admin role access to an Entra ID account"
    - "give this user Compliance Administrator role in Azure AD"
  pill:
    label: Assign Entra Role
    goal: I need to assign a Microsoft Entra directory role to a user, granting them tenant-wide administrative permissions
    icon: UserCog
    iconClass: text-purple-500
    order: 24
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
---

## When to use

Use this skill when an admin needs to grant a Microsoft Entra ID built-in directory role (e.g. Global Reader, User Administrator, Helpdesk Administrator, Compliance Administrator) to a user, giving them the tenant-wide administrative permissions that role carries.

Do NOT use for Okta or Google role/permission changes. Do NOT use for enterprise application access (`entra-access-request`) or licence assignment (`entra-license-assign`) — those grant different, narrower kinds of access. Do NOT use for MFA problems (`entra-mfa-reset`) or password problems (`entra-password-reset`). Do NOT use this skill to remove or downgrade a role — it only grants.

**Precondition:** directory roles are powerful and tenant-wide. Always resolve the exact role by name via `c_entra_find_role` and check existing assignments via `c_entra_get_role_assignments` before granting — never assign a role the user already holds, and never guess a `roleDefinitionId`.

---

## Steps

**Step 1 — Verify user account exists**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the cloud gateway is not set up on this machine; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask the user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; role assignment can still be granted but sign-in stays blocked until re-enabled
- On success, note `displayName` for messaging

**Step 2 — Capture the role name**

Call `request_user_input` asking for the exact name of the directory role to assign (e.g. "Global Reader", "Helpdesk Administrator"), if not already stated.

**Step 3 — Resolve the role**

Call `c_entra_find_role` with the name from Step 2.

- No matches → tell the user no built-in role matched that name and STOP; advise them to re-run this skill with the correct name
- More than 4 matches → tell the user the name is too broad and STOP; advise them to re-run this skill with a more specific role name
- One to four matches → proceed to Step 4

**Step 4 — Confirm the exact role**

Only when Step 3 returned more than one match (up to 4). Use `wait_for_user_ack` to let the user pick the exact role from the matches. Skip this step if Step 3 returned exactly one match — use it directly.

**Step 5 — Check existing role assignments**

Call `c_entra_get_role_assignments`.

- If the resolved role's `roleDefinitionId` already appears in the list → tell the user {displayName} already holds this role; this would be a no-op — STOP
- Otherwise proceed, noting the user's current roles for context

**Step 6 — Confirm the assignment**

Use `wait_for_user_ack` to confirm: "This will assign the {roleDisplayName} role to {displayName} ({upn}), granting the tenant-wide permissions of that role. Proceed?"

MUST get explicit confirmation before proceeding. Do not skip this step.

**Step 7 — Execute the assignment**

Call `c_entra_assign_role` with the confirmed `roleDefinitionId` from Step 3/4.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the cloud gateway is not set up; contact IT admin

**Step 8 — Verify the assignment**

Call `c_entra_get_role_assignments` again to confirm the new `roleDefinitionId` now appears in the list.

**Step 9 — Guide the user**

Tell the user:
- {displayName} has been granted the {roleDisplayName} role
- The permissions apply tenant-wide and take effect on the user's next Entra token refresh (usually within an hour, sometimes requires re-sign-in)
- If the wrong role was granted, this skill can be re-run to add a different one, but role removal requires a separate admin action outside this skill
- For app-specific or licence-related access instead, point to `entra-access-request` or `entra-license-assign`

---

## Edge cases

- **Role name matches nothing:** Step 3 stops the run; the user must re-run this skill with a different or more precise name.
- **Role name matches more than 4 roles:** `wait_for_user_ack` cannot list them all — Step 3 stops the run and asks the user to re-run with a narrower name.
- **Role already assigned:** Step 5 must catch this and stop — assigning it again is a no-op and wastes a consent gate.
- **Account disabled:** flag but do not block — role assignment is independent of `accountEnabled`, though the user cannot use the permissions until sign-in is restored.
- **User needs app access or a licence, not a directory role:** redirect to `entra-access-request` or `entra-license-assign` — this skill only grants directory roles.