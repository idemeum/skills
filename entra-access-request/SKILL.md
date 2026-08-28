---
name: entra-access-request
description: Grants a Microsoft Entra ID user access to a specific security group, Microsoft 365 group, or enterprise application (service principal) they are currently missing — via direct group membership or an app role assignment, whichever the target actually requires. Use when the user says "I need access to the Finance SharePoint site", "add me to the Marketing distribution list", "I can't open Workday and think I need the app assigned", "request access to the Salesforce enterprise app in Entra", or similar Entra group/app access complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - c_entra_get_user_info
  - request_user_input
  - c_entra_find_group
  - c_entra_find_app
  - c_entra_get_group_memberships
  - c_entra_get_app_assignments
  - wait_for_user_ack
  - c_entra_add_to_group
  - c_entra_assign_app
metadata:
  maxAggregateRisk: high
  userLabel: "Request Entra group or app access"
  examples:
    - "add me to the Finance security group in Entra"
    - "I need access to the Marketing Microsoft 365 group"
    - "assign me the Salesforce enterprise app in Entra ID"
    - "I can't open Workday, I think I need the app assigned in Entra"
    - "request access to a SharePoint site's Entra group"
    - "grant this user membership in the Contractors distribution list"
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
  pill:
    label: Request Entra Access
    goal: I need access to a Microsoft Entra group or application that I don't currently have
    icon: Users
    iconClass: text-blue-500
    order: 22
---

## When to use

Use when a Microsoft Entra ID user is missing access to a resource that is granted either as group membership (security group, Microsoft 365 group, distribution list, Teams, SharePoint site) or as an enterprise app assignment (service principal), and it is not obvious to the user which mechanism applies. This skill resolves the target by name and grants access via whichever mechanism it turns out to be.

Do NOT use for Okta or Google access requests — different admin APIs. Do NOT use for Microsoft 365 licence assignment (`entra-license-assign`) or Entra directory role assignment (`entra-role-assign`) — those are distinct grant types even when the user describes them as "access". Do NOT use for MFA problems (`entra-mfa-reset`) or password problems (`entra-password-reset`).

---

## Steps

**Step 1 — Verify user account exists**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; access grants will not restore sign-in
- On success, note `displayName` for messaging

**Step 2 — Capture what access is needed**

Call `request_user_input`:

```yaml
prompt: "What do you need access to? Name the group, distribution list, Teams, SharePoint site, or application."
placeholder: "e.g. Marketing Team, Salesforce"
```

Skip this step if the user already named the target in their request.

**Step 3 — Search matching groups**

Call `c_entra_find_group` with the name from Step 2.

- A non-null `membershipRule` means the group is dynamic — it cannot accept a direct member add. Exclude it from candidates and tell the user membership is rule-based (e.g. by department) and must be requested a different way.

**Step 4 — Search matching apps**

Call `c_entra_find_app` with the name from Step 2.

**Step 5 — Check existing group memberships**

Call `c_entra_get_group_memberships`. Exclude any Step 3 candidate the user already belongs to — adding them again would be a no-op.

**Step 6 — Check existing app assignments**

Call `c_entra_get_app_assignments`. Exclude any Step 4 candidate the user is already assigned — assigning again would be a no-op.

**Step 7 — Confirm the exact target**

Call `wait_for_user_ack`:

```yaml
prompt: "Which one do you need access to?"
options:
  - { id: "none-of-these", label: "None of these", kind: "cancel" }
```

Then prepend one option per remaining candidate (max 3, before the `none-of-these` entry) — the groups and apps left after Steps 5/6 excluded what the user already has. Prefix each `id` so the downstream branch is testable: `group:` followed by the `groupId` for a group, `app:` followed by the `servicePrincipalId` for an app. Set `label` to the candidate's display name. `inputsFrom: [{ step: 3, field: "groups" }, { step: 4, field: "apps" }]`.

If nothing remains after exclusions, do NOT call this gate — tell the user they already have the access they described, or that no match was found, and stop. On `none-of-these` → end the run and ask the user to describe the target more precisely.

**Step 8 — Add to group**

`Condition:` only run if Step 7 returned an id starting with `group:`.

Call `c_entra_add_to_group` with the `groupId` from Step 3.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 9 — Assign app**

`Condition:` only run if Step 7 returned an id starting with `app:`.

Call `c_entra_assign_app` with the `servicePrincipalId` from Step 4.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 10 — Verify group addition**

If Step 8 ran, call `c_entra_get_group_memberships` again to confirm the group now appears.

**Step 11 — Verify app assignment**

If Step 9 ran, call `c_entra_get_app_assignments` again to confirm the app now appears.

**Step 12 — Guide the user**

Tell the user:
- Access to {target name} has been granted for {displayName}
- Group membership and app assignment can take a few minutes to propagate; some apps also require a fresh sign-in to pick up the change
- If access still doesn't work after propagation, check the app's own permission model — some apps require an in-app role separate from Entra
- If they also need a licence or a directory role, mention `entra-license-assign` or `entra-role-assign` as separate follow-ups

---

## Edge cases

- **Dynamic group requested:** never call `c_entra_add_to_group` on a group with a `membershipRule` — it will fail or silently not stick. Tell the user membership is automatic based on rules and direct add isn't possible.
- **User already has the access:** exclude it in Step 7; if it was the only candidate, tell the user they already have it and stop rather than presenting an empty confirmation.
- **No matches found in either search:** tell the user no matching group or app was found and ask them to confirm the exact name, or that the resource may not exist in this tenant.
- **Ambiguous name matches both a group and an app:** present both as separate options in Step 7 — do not guess which one the user means.
- **Account disabled:** flag it, but grants can still be issued; sign-in stays blocked until an admin re-enables the account.