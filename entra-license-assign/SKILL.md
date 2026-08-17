---
name: entra-license-assign
description: Assigns a Microsoft 365 licence SKU (e.g. E3, E5, Teams Phone) to a Microsoft Entra ID user from the tenant's purchased seat pool. Use when a user needs a Microsoft 365/Office 365 licence added, a new hire is missing a licence, or an admin needs to assign a specific Entra licence SKU with available seats.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - detect_identity_provider
  - detect_idp_username
  - wait_for_user_ack
  - request_user_input
  - c_entra_get_user_info
  - c_entra_get_licenses
  - c_entra_get_available_licenses
  - c_entra_assign_license
metadata:
  prerequisites:
    before-corrective:
      - detect_identity_provider
  maxAggregateRisk: high
  userLabel: "Assign a Microsoft 365 licence to an Entra user"
  examples:
    - "assign a Microsoft 365 E3 license to this Entra user"
    - "user needs an Office 365 license added in Entra ID"
    - "grant a Microsoft 365 licence SKU to a new hire in Azure AD"
    - "assign Teams Phone license to an Entra account"
    - "user is missing a Microsoft 365 license, need to assign one from available seats"
    - "add an Entra ID licence assignment for this employee"
  pill:
    label: Assign Entra License
    goal: I need to assign a Microsoft 365 license to a Microsoft Entra ID user
    icon: BadgeCheck
    iconClass: text-blue-500
    order: 24
---

## When to use

Use this skill when a Microsoft Entra ID user needs a Microsoft 365 licence SKU assigned — a new hire missing a licence, a user needing a specific plan (E3, E5, Teams Phone, etc.), or an admin assigning from the tenant's purchased seat pool.

Do NOT use for app or group access requests (`entra-access-request`) or directory role assignments (`entra-role-assign`) — licences, app roles, and directory roles are distinct Entra constructs. Do NOT use for MFA re-enrollment (`entra-mfa-reset`), forgotten passwords (`entra-password-reset`), or account lockouts (`entra-account-unlock`). Do NOT use for Okta or Google licensing — those are different admin APIs.

**Precondition:** Microsoft requires `usageLocation` to be set on the user before any licence can be assigned. Always check `usageLocation` from `c_entra_get_user_info` first — if it is null/empty, do NOT proceed; this is a hard stop, not a warning.

---

## Steps

**Step 1 — Detect the identity provider**

Call `detect_identity_provider`. Check if `"entra"` appears in `output.primary` OR `output.secondary`. If not detected, this skill does not apply — tell the user their device is not enrolled with Microsoft Entra and suggest a support ticket.

**Step 2 — Auto-discover the username**

Call `detect_idp_username` with `idp: "entra"`.

**Step 3 — Confirm the account**

Call `wait_for_user_ack` to confirm, e.g. "Is this your Microsoft account: {primaryUsername}?" If `candidates` has multiple entries, present up to 3 choices plus a "different account" escape option.

**Step 4 — Capture the UPN manually**

Condition: only when Step 2 found no username, or the user chose the escape option in Step 3. Call `request_user_input` asking for their Entra UPN (may look like an email, may differ from personal email in hybrid AD setups).

**Step 5 — Verify account and usage location**

Call `c_entra_get_user_info` with the confirmed UPN.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- **`usageLocation` is null/empty → STOP.** Tell the user Microsoft requires a usage location before any licence can be assigned; they must set it (via admin/portal) and retry this skill
- `accountEnabled` is `false` → warn the account is disabled; licence assignment can still proceed but sign-in stays blocked
- On success, note `displayName` for messaging

**Step 6 — Check current licences**

Call `c_entra_get_licenses` with the confirmed UPN. Note assigned `skuId`s so they can be excluded from the selection list — assigning a licence the user already holds would be a no-op.

**Step 7 — Check available tenant licences**

Call `c_entra_get_available_licenses`. Exclude SKUs already held (Step 6) and SKUs with `usedSeats >= totalSeats` (no seats left) to build the eligible list.

**Step 8 — Select the licence to assign**

Call `wait_for_user_ack` presenting up to 3 eligible SKUs from Step 7 (by `skuPartNumber`, with seats remaining) plus a "different licence" escape option.

If no SKUs are eligible, tell the user and stop — recommend procurement if seats are exhausted.

**Step 9 — Capture licence name manually**

Condition: only when Step 7 found more than 3 eligible SKUs, or the user chose the escape option in Step 8. Call `request_user_input` asking for the exact licence name or part number, matched against the list from Step 7 to resolve the `skuId`.

**Step 10 — Confirm the assignment**

Call `wait_for_user_ack` to confirm: "Assign {skuPartNumber} to {displayName} ({upn})? Seats remaining: {totalSeats - usedSeats}." MUST get explicit confirmation before proceeding.

**Step 11 — Execute the assignment**

Call `c_entra_assign_license` with the confirmed UPN and the `skuId` resolved in Step 8 or Step 9.

- `status: "ok"` → proceed to verification
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin

**Step 12 — Verify the assignment**

Call `c_entra_get_licenses` with the confirmed UPN again to confirm the new `skuId` now appears in the returned list.

**Step 13 — Deliver guidance**

Tell the user:
- The licence has been assigned to {displayName} ({upn})
- Licence-based app access (e.g. Teams, Exchange) may take a few minutes to activate
- If the user also needs specific app or group access, a separate access request skill can help; for directory role needs, a separate role assignment skill applies

---

## Edge cases

- **Missing `usageLocation`:** hard stop at Step 5 — never call `c_entra_assign_license` without it; the gateway call would fail.
- **Licence already assigned:** excluded from the Step 7/8 selection so the user cannot request a no-op.
- **No seats remaining:** SKUs with `usedSeats >= totalSeats` are excluded at Step 7; if nothing is eligible, tell the user to request procurement rather than attempting the assignment.
- **More than 3 eligible SKUs:** captured via free text in Step 9 instead of overloading the 4-option limit of `wait_for_user_ack`.
- **Account disabled:** licence assignment can still proceed at Step 5, but the user cannot sign in to use it until the account is re-enabled.