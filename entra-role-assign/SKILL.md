---
name: entra-role-assign
description: Assigns an Entra built-in directory role (e.g. Global Administrator, User Administrator, Helpdesk Administrator) to a user, granting the tenant-wide permissions associated with that role. Use when an admin says "give this user the Global Reader role", "make someone a User Administrator in Entra", "assign a directory role in Azure AD", or similar requests naming a specific Entra administrative role.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - wait_for_user_ack
  - request_user_input
  - c_entra_get_user_info
  - c_entra_get_role_assignments
  - c_entra_find_role
  - c_entra_assign_role
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
  maxAggregateRisk: high
  userLabel: "Assign an Entra directory role"
  examples:
    - "assign the Global Administrator role to a user in Entra"
    - "make this user a Helpdesk Administrator in Azure AD"
    - "grant the User Administrator directory role in Microsoft Entra"
    - "user needs the Exchange Administrator role assigned in Entra"
    - "add someone to the Security Reader role in Azure AD"
    - "escalate a user's Entra role to Compliance Administrator"
  pill:
    label: Assign Entra Role
    goal: I need to assign a Microsoft Entra directory role, such as Global Administrator or Helpdesk Administrator, to a user
    icon: UserCog
    iconClass: text-purple-500
    order: 25
---

## When to use

Use this skill when an admin needs to grant a Microsoft Entra ID user a built-in directory role (Global Administrator, User Administrator, Helpdesk Administrator, Exchange Administrator, etc.), giving them tenant-wide permissions for that role's scope.

Do NOT use for Okta or Google role/permission requests — those require different admin APIs. Do NOT use for application or group access requests (`entra-access-request`) or licence assignment (`entra-license-assign`) — those are narrower, non-privileged grants. Do NOT use for MFA reset (`entra-mfa-reset`), password reset (`entra-password-reset`), or account unlock (`entra-account-unlock`) — different root causes. Directory roles carry elevated, tenant-wide privilege — always confirm the exact role name and its scope with the user before assigning.

---

## Steps

**Step 1 — Detect the identity provider**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If not detected, this skill does not apply — tell the user their device is not enrolled with Microsoft Entra and suggest a support ticket.

**Step 2 — Auto-discover the username**

Call `detect_idp_username` with `idp: "entra"`.

**Step 3 — Confirm the account**

Call `wait_for_user_ack` to confirm, e.g. "Is this the account to grant a role to: {primaryUsername}?" If `candidates` has multiple entries, present up to 4 choices plus a "different account" escape option.

**Step 4 — Capture the UPN manually**

Condition: only when Step 2 found no username, or the user chose "different account" in Step 3. Call `request_user_input` asking for the target Entra UPN (may look like an email, may differ from personal email in hybrid AD setups).

**Step 5 — Verify the account**

Call `c_entra_get_user_info` with the confirmed UPN.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask the user to double-check spelling
- `accountEnabled` is `false` → warn the user the account is disabled; assigning a role will not restore sign-in access
- On success, note `displayName` for messaging

**Step 6 — Check current role assignments**

Call `c_entra_get_role_assignments` with the confirmed UPN. Retain the returned list to check for a duplicate assignment in Step 9.

**Step 7 — Capture the desired role**

Call `request_user_input` asking which Entra directory role to assign (e.g. "Global Administrator", "User Administrator", "Helpdesk Administrator").

**Step 8 — Resolve the role**

Call `c_entra_find_role` with the name from Step 7.

- No matches → tell the user no built-in role matched that name; ask them to rephrase or check the exact role name
- One match → proceed
- Multiple matches → present up to 4 as options in the next step

**Step 9 — Confirm the exact role and check for duplicates**

Call `wait_for_user_ack`.

- If Step 8 returned multiple matches → present each `displayName` as an option (max 4) plus a "none of these" escape option
- If the resolved `roleDefinitionId` already appears in Step 6's role list → present a single acknowledgement option stating {displayName} already holds this role; the flow ends here with no assignment made
- Otherwise confirm the single match: "Assign the {displayName} role to {displayName from Step 5}?"

**Step 10 — Confirm the grant**

Condition: only when Step 9 confirmed a new (not already-held) role. Use `wait_for_user_ack` to confirm: "This will grant {roleName} to {displayName} ({upn}) tenant-wide, effective immediately. Proceed?"

MUST get explicit confirmation before proceeding — this is a privileged, tenant-wide grant. Do not skip this step.

**Step 11 — Execute the assignment**

Call `c_entra_assign_role` with the confirmed UPN and the resolved `roleDefinitionId` from Step 8.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 12 — Verify the assignment**

Call `c_entra_get_role_assignments` with the confirmed UPN to confirm the new role now appears in the list.

**Step 13 — Deliver guidance**

Tell the user:
- {displayName} now holds the {roleName} role, effective immediately tenant-wide (or, if the role was already held, that no change was made)
- Role permissions may take a few minutes to propagate across Microsoft 365 services
- If they also need app/group access or a licence, mention `entra-access-request` or `entra-license-assign` as separate follow-ups
- Directory roles should be reviewed periodically and removed when no longer needed

---

## Edge cases

- **Role name doesn't resolve:** if `c_entra_find_role` returns no matches, do not guess — ask the user to confirm the exact built-in role name rather than assigning the closest-sounding one.
- **Role already assigned:** if the resolved role already appears in the user's current assignments, the flow ends with an acknowledgement and no assignment call is made — this avoids wasting a consent gate on a no-op.
- **Account disabled:** flag during verification but do not block the assignment — role membership is independent of `accountEnabled`, though sign-in stays blocked until re-enabled.
- **Ambiguous role name:** if multiple roles match (e.g. "Administrator" matches several), present up to 4 candidates for the user to pick from rather than guessing one.