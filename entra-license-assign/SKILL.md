---
name: entra-license-assign
description: Assigns a Microsoft 365 licence SKU (e.g. E3, E5) to a Microsoft Entra ID user via the admin Graph API, after confirming the tenant has purchased seats available and the user has a usage location set — a hard Microsoft precondition. Use when a user needs a Microsoft 365 licence assigned or reassigned in Entra ID, such as a new hire missing a licence, a licence that was removed, or a user needing a different SKU to unlock Teams/Office features.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - request_user_input
  - wait_for_user_ack
  - c_entra_get_user_info
  - c_entra_get_licenses
  - c_entra_get_available_licenses
  - c_entra_assign_license
metadata:
  maxAggregateRisk: high
  userLabel: "Assign a Microsoft 365 licence in Entra"
  examples:
    - "assign a Microsoft 365 E3 licence to this Entra user"
    - "user needs an Office 365 licence added in Entra ID"
    - "new hire needs a Microsoft 365 licence assigned before they can use Teams"
    - "grant this Entra account an E5 licence so they can use Teams Phone"
    - "user's Microsoft 365 licence was removed, need to reassign it"
    - "assign a licence SKU to an Azure AD user account"
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
  pill:
    label: Assign Entra Licence
    goal: I need a Microsoft 365 licence assigned to a user in Entra ID because they're missing access to a licensed app
    icon: BadgeCheck
    iconClass: text-blue-500
    order: 24
---

## When to use

Use this skill when a Microsoft Entra ID user needs a Microsoft 365 licence SKU (e.g. E3, E5, Business Premium) assigned — a new hire with no licence, a licence that was removed and needs restoring, or an upgrade/change to a different SKU.

Do NOT use for Okta or Google licensing — those are managed outside Entra. Do NOT use for application or group access requests (`entra-access-request`) — a licence is a Microsoft 365 entitlement, not an app permission or group membership. Do NOT use for directory role assignment (`entra-role-assign`) — a role is administrative privilege, not a licence. Do NOT use for MFA re-enrollment (`entra-mfa-reset`), forgotten passwords (`entra-password-reset`), or account lockouts (`entra-account-unlock`).

**Precondition:** Microsoft requires a `usageLocation` (country code) to be set on the user before any licence can be assigned. Always check `usageLocation` from `c_entra_get_user_info` first and stop if it is null.

---

## Steps

**Step 1 — Verify account and usage location**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- **`usageLocation` is null/empty → STOP.** Microsoft will reject a licence assignment without it. Tell the user an admin must set a usage location (country code) on the account first, and do not proceed
- `accountEnabled` is `false` → warn the licence can still be assigned but sign-in stays blocked until the account is re-enabled
- On success, note `displayName` and `usageLocation` for messaging

**Step 2 — Check currently assigned licences**

Call `c_entra_get_licenses`.

Note the `skuPartNumber` values already held by the user so they can be excluded from the choices offered next — assigning a licence the user already has is a no-op.

**Step 3 — Check tenant licence inventory**

Call `c_entra_get_available_licenses`.

Filter to SKUs the user does NOT already hold (from Step 2) and that have at least one free seat (`totalSeats` > `usedSeats`). Present the eligible SKUs with their remaining seat counts. If none are eligible, tell the user no purchasable licence is available and stop.

**Step 4 — Capture the desired licence**

Call `request_user_input` asking the user to type the exact `skuPartNumber` of the licence they want, chosen only from the eligible list presented in Step 3.

**Step 5 — Confirm the assignment**

Use `wait_for_user_ack` to confirm: "Assign {skuPartNumber} to {displayName} ({upn})? Seats remaining after assignment: {seatsLeft - 1}." Options: Yes / No.

MUST get explicit confirmation before proceeding. If the SKU named in Step 4 has zero seats remaining or was not in the eligible list from Step 3, do not offer this confirmation — tell the user that SKU is unavailable and stop; they may restart the skill to choose a different one.

**Step 6 — Execute the assignment**

Call `c_entra_assign_license` with the resolved `skuId` matching the confirmed `skuPartNumber`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "ok"` → proceed to verification

**Step 7 — Verify the assignment**

Call `c_entra_get_licenses` again to confirm the new `skuPartNumber` now appears in the user's licence list.

**Step 8 — Guide the user**

Tell the user:
- {skuPartNumber} has been assigned to {displayName} ({upn})
- Licence-based features (Teams, Office apps, etc.) may take a few minutes to propagate
- If they were expecting app or group access rather than a licence entitlement, mention `entra-access-request`
- If the account was disabled, remind them sign-in stays blocked until it is re-enabled

---

## Edge cases

- **No `usageLocation` set:** hard stop at Step 1 — never call the corrective without it; Microsoft's API will reject the request anyway.
- **User already holds the licence:** excluded from the choices in Step 3; if the user insists, tell them it is already assigned and no action is needed.
- **No seats available for desired SKU, or SKU not in the eligible list:** do not proceed past Step 5; tell the user to restart with a different SKU or ask an admin to purchase more seats.
- **Account disabled:** the licence can still be assigned, but sign-in remains blocked until an admin re-enables the account — flag this, don't block on it.
- **Tenant has no eligible SKUs at all:** stop after Step 3 and tell the user there is nothing purchasable to assign.