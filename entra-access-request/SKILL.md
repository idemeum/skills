---
name: entra-access-request
description: Grants a Microsoft Entra ID user access to a specific security group or enterprise application they are currently missing, resolving the exact group or app by name before adding membership or an app role assignment. Use when the user says "I need access to a Teams/SharePoint site restricted by an Entra group", "add me to the Marketing group in Entra", "I can't open [enterprise app] and IT says I'm missing the assignment", or similar Entra group/app access complaints.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - wait_for_user_ack
  - request_user_input
  - c_entra_get_user_info
  - c_entra_find_group
  - c_entra_find_app
  - c_entra_get_group_memberships
  - c_entra_get_app_assignments
  - c_entra_add_to_group
  - c_entra_assign_app
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
  maxAggregateRisk: high
  userLabel: "Request Entra group or app access"
  examples:
    - "user needs access to a SharePoint site restricted by an Entra security group"
    - "add this employee to the Marketing Entra 365 group"
    - "assign the Salesforce enterprise app to a new hire in Entra"
    - "user can't open an internal tool because they're missing the Entra app assignment"
    - "add user to an Entra distribution group for project access"
    - "grant access to an enterprise application via Microsoft Entra ID"
  pill:
    label: Request Entra Access
    goal: I need access to a group or application in Microsoft Entra ID that I don't currently have
    icon: UserPlus
    iconClass: text-blue-500
    order: 23
---

## When to use

Use when a Microsoft Entra ID user is missing access to a specific group (security or Microsoft 365) or enterprise application (app role assignment) and needs it added. The user names the resource — this skill resolves whether it is a group or app and grants access by the correct mechanism.

Do NOT use for MFA reset (`entra-mfa-reset`), password reset (`entra-password-reset`), or lockouts (`entra-account-unlock`). Do NOT use for licence assignment (`entra-license-assign`) or directory role assignment (`entra-role-assign`) — separate correctives. Do NOT use for Okta or Google access requests.

---

## Steps

**Step 1 — Detect the identity provider**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If not detected, this skill does not apply — tell the user their device is not enrolled with Microsoft Entra and suggest a support ticket.

**Step 2 — Auto-discover the username**

Call `detect_idp_username` with `idp: "entra"`.

**Step 3 — Confirm the account**

Call `wait_for_user_ack` to confirm, e.g. "Is this your Microsoft account: {primaryUsername}?" If `candidates` has multiple entries, present up to 3 plus a "different account" escape option.

**Step 4 — Capture the UPN manually**

Condition: only when Step 2 found no username, or the user chose the escape option in Step 3. Call `request_user_input` asking for their Entra UPN.

**Step 5 — Verify the account**

Call `c_entra_get_user_info` with the confirmed UPN.

- `status: "not-configured"` → gateway not set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn access grants won't restore sign-in alone
- On success, note `displayName` for messaging

**Step 6 — Ask what access is needed**

Call `request_user_input` asking the user to name the group, team, or application they need (e.g. "Marketing 365 group", "Salesforce").

**Step 7 — Search for matching groups**

Call `c_entra_find_group` with the name from Step 6. Exclude results with a non-null `membershipRule` — dynamic groups can't accept a direct add.

**Step 8 — Search for matching apps**

Call `c_entra_find_app` with the name from Step 6.

**Step 9 — Check existing group memberships**

Call `c_entra_get_group_memberships` with the confirmed UPN. Exclude any Step 7 group already held.

**Step 10 — Check existing app assignments**

Call `c_entra_get_app_assignments` with the confirmed UPN. Exclude any Step 8 app already held.

**Step 11 — Present candidates and let the user pick**

Call `wait_for_user_ack` listing the remaining static-group and app candidates (from Steps 7–10) by display name, plus a "none of these" escape — max 4 options. If more than 3 candidates remain, present only the 3 closest name matches. If none remain, tell the user they already have the described access, or no match was found, and stop.

**Step 12 — Confirm the exact target**

Call `wait_for_user_ack`: "This will add {displayName} to the group {groupDisplayName}" or "This will assign {displayName} the app {appDisplayName}. Proceed?" MUST get explicit confirmation.

**Step 13 — Add to group**

Condition: only when Step 11's selection was a group. Call `c_entra_add_to_group` with the confirmed UPN and the `groupId` from Step 7.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → gateway not set up; contact IT admin

**Step 14 — Assign app**

Condition: only when Step 11's selection was an app. Call `c_entra_assign_app` with the confirmed UPN and the `servicePrincipalId` from Step 8.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → gateway not set up; contact IT admin

**Step 15 — Verify group membership**

Condition: only when Step 13 executed. Call `c_entra_get_group_memberships` with the confirmed UPN to confirm the group now appears.

**Step 16 — Verify app assignment**

Condition: only when Step 14 executed. Call `c_entra_get_app_assignments` with the confirmed UPN to confirm the app now appears.

**Step 17 — Guide the user**

Tell the user:
- Access has been granted and may take a few minutes to propagate
- If access still doesn't appear, sign out and back in to refresh their token
- For a licence to use the app, see `entra-license-assign`; for a directory role instead of group/app access, see `entra-role-assign`

---

## Edge cases

- **Dynamic group:** excluded in Step 7 (`membershipRule` non-null) — tell the user it's rule-managed if it's their only match.
- **Already has access:** Steps 9–10 exclude held items; if nothing remains, say so instead of running a no-op.
- **No matches:** if Steps 7 and 8 both return empty, tell the user no group or app matches and suggest checking the name or filing a ticket.
- **Ambiguous name matches both:** present both as separate candidates in Step 11 — never guess the mechanism.
- **More than 3 candidates:** show the 3 closest matches only; the picker caps at 4 options.