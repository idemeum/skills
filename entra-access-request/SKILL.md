---
name: entra-access-request
description: Grants a Microsoft Entra ID user access to a specific security group, Microsoft 365 group, or enterprise application they are currently missing, resolving the target by name search rather than requiring the user to know whether it is implemented as group membership or an app role assignment. Use when the user says "I need access to the Marketing group", "add me to a Teams/SharePoint group in Entra", "assign me the Salesforce app", "I can't see an app I should have access to", or similar Entra access-request complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - request_user_input
  - c_entra_get_user_info
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
    - "user needs access to the Marketing SharePoint group in Entra"
    - "add me to the VPN security group in Azure AD"
    - "assign the Salesforce enterprise app to this Entra user"
    - "user can't see the Finance Teams channel, needs group access in Entra ID"
    - "grant a new hire access to the internal Wiki app in Entra"
    - "user needs to be added to a distribution list in Microsoft Entra"
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
  pill:
    label: Request Entra Access
    goal: I need access to a group or application in Microsoft Entra ID that I don't currently have
    icon: UserPlus
    iconClass: text-blue-500
    order: 23
---

## When to use

Use this skill when a Microsoft Entra ID user needs access to a specific group (security group or Microsoft 365 group) or enterprise application they don't currently have. The user names the thing they need (a group or app by name); this skill resolves whether it is granted via group membership or an app role assignment and executes the matching corrective.

Do NOT use for MFA re-enrollment (`entra-mfa-reset`), forgotten passwords (`entra-password-reset`), or lockouts (`entra-account-unlock`) — those are unrelated failure modes. Do NOT use for licence assignment (`entra-license-assign`) or directory role assignment (`entra-role-assign`) — those are different Entra objects with their own skills, even though they also "grant access". Do NOT use for Okta or Google group/app requests — those require different admin APIs.

---

## Steps

**Step 1 — Verify user account**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; access can still be granted but won't be usable until re-enabled
- On success, note `displayName` for messaging

**Step 2 — Ask what they need access to**

Call `request_user_input` asking the user to name the group or application they need access to (e.g. "Marketing-Team", "Salesforce").

**Step 3 — Search matching groups**

Call `c_entra_find_group` with the name from Step 2.

Note any `membershipRule` — a non-null rule means that group is dynamic and cannot accept a direct member add; exclude it from candidates or flag it as not addable by this skill.

**Step 4 — Search matching apps**

Call `c_entra_find_app` with the name from Step 2.

**Step 5 — Exclude groups already held**

Call `c_entra_get_group_memberships`.

Drop any Step 3 group already in this list — the user already has that access.

**Step 6 — Exclude apps already assigned**

Call `c_entra_get_app_assignments`.

Drop any Step 4 app already in this list — the user already has that access.

**Step 7 — Pick and confirm the exact target**

Use `wait_for_user_ack` presenting the remaining candidates (max 4, combining groups and apps from Steps 3–6), each phrased as the concrete change it makes, e.g. "Add to Marketing-Team group" / "Assign Salesforce app". Include a "None of these" escape if space allows.

MUST get an explicit pick before proceeding. If more than 4 candidates remain, narrow with `request_user_input` for a more specific name before re-presenting (see Edge cases).

**Step 8 — Add to group (if a group was chosen)**

Call `c_entra_add_to_group` with the `groupId` of the group selected in Step 7. Only when the Step 7 selection was a group.

- `status: "ok"` → proceed to guidance
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 9 — Assign app (if an app was chosen)**

Call `c_entra_assign_app` with the `servicePrincipalId` of the app selected in Step 7. Only when the Step 7 selection was an app.

- `status: "ok"` → proceed to guidance
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 10 — Guide the user**

Tell the user:
- The access has been granted for {displayName}
- Group membership changes can take a few minutes to propagate across Microsoft 365 services; app assignments are usually immediate but may require a sign-out/sign-in to appear
- If the item they needed wasn't in the candidate list, ask them to double-check the exact name or contact IT to confirm it exists
- Licence problems, role assignments, or MFA/password/lockout issues are handled by separate skills (`entra-license-assign`, `entra-role-assign`, `entra-mfa-reset`, `entra-password-reset`, `entra-account-unlock`)

---

## Edge cases

- **Dynamic group (non-null `membershipRule`):** cannot accept a direct member add — exclude it from the Step 7 candidates or clearly flag it as not addable this way; direct the user to whatever attribute drives the rule instead.
- **User already has the access:** if Steps 5/6 remove every candidate, tell the user they already have it and stop — do not call a corrective.
- **No matches found:** if Steps 3 and 4 both return no candidates, tell the user nothing matched that name and ask them to try a different spelling or confirm the exact group/app name with their manager or IT.
- **More than 4 remaining candidates:** narrow the search with a follow-up `request_user_input` for a more specific name rather than truncating silently — `wait_for_user_ack` cannot show more than 4 options.
- **Name matches both a group and an app:** present both as distinct options in Step 7 and let the user pick; do not guess.
- **Account disabled:** access can still be granted, but note it will not be usable until the account is re-enabled.