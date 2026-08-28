---
name: entra-license-assign
description: Assigns a Microsoft 365 licence SKU (e.g. E3, E5, Teams) to a Microsoft Entra ID user via the Graph API, after confirming the tenant has an available seat and the user has a usage location set. Use when a user needs an Office/Microsoft 365 licence provisioned, a new hire is missing a licence SKU, or an app is blocked because the user's Entra account lacks the required licence.
license: Proprietary
compatibility: Requires Node.js 18+, Windows or macOS
allowed-tools:
  - c_entra_get_user_info
  - c_entra_get_licenses
  - c_entra_get_available_licenses
  - request_user_input
  - wait_for_user_ack
  - c_entra_assign_license
metadata:
  maxAggregateRisk: high
  userLabel: "Assign a licence to an Entra user"
  examples:
    - "assign a Microsoft 365 license to a new Entra user"
    - "user needs an E3 license added in Entra ID"
    - "grant an Office 365 license to this Azure AD account"
    - "new hire is missing their Microsoft 365 license SKU"
    - "add a Teams license to an Entra user"
    - "user says they have no Microsoft 365 license assigned in Entra"
  prerequisites:
    before-corrective:
      - c_entra_get_user_info
  pill:
    label: Assign Entra License
    goal: I need to assign a Microsoft 365 license SKU to an Entra user
    icon: BadgeCheck
    iconClass: text-blue-500
    order: 23
---

## When to use

Use this skill when a Microsoft Entra ID user needs a Microsoft 365 licence SKU (E1/E3/E5, Teams, EMS, etc.) assigned — new hire onboarding, a missing licence blocking an app, or an admin request to add a specific SKU to a user's account.

Do NOT use for Okta or Google account issues — this is Entra/Graph-specific. Do NOT use for app or group access requests (`entra-access-request`), directory role assignment (`entra-role-assign`), MFA problems (`entra-mfa-reset`), or password problems (`entra-password-reset`). Do NOT use when the user already has the licence they're asking for — check current licences first and tell them if it's already assigned.

**Precondition:** Microsoft Graph requires a `usageLocation` (country code) on the user before any licence can be assigned. This skill has no tool to set it. If `usageLocation` is missing, STOP and tell the user an admin must set it in Entra first.

---

## Steps

**Step 1 — Verify account and usage location**

Call `c_entra_get_user_info`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"`, `httpStatus: 404` → UPN not found; ask user to check spelling
- `accountEnabled` is `false` → warn the account is disabled; licence can still be assigned but sign-in stays blocked until re-enabled
- **`usageLocation` is null/empty → STOP.** Tell the user Microsoft Graph requires a usage location before a licence can be assigned, and this skill cannot set one — an admin must add it in Entra first
- On success, note `displayName` for messaging

**Step 2 — Check current licences**

Call `c_entra_get_licenses`.

Note the `skuPartNumber` values already assigned — these must be excluded from what's offered next so the user isn't offered a no-op.

**Step 3 — Check tenant licence inventory**

Call `c_entra_get_available_licenses`.

Filter to SKUs the user does not already have (from Step 2) and that have at least one free seat (`totalSeats > usedSeats`). If none remain, tell the user either everything is already assigned or the tenant is out of seats for the SKUs it has, and stop.

**Step 4 — Ask which licence to assign**

Call `request_user_input`:

```yaml
prompt: "Which licence should I assign? Available: {skuList}"
placeholder: "e.g. ENTERPRISEPACK"
```

Substitute `{skuList}` with the filtered SKU part numbers and their remaining seat counts from Step 3. Match their answer to a `skuId` from Step 3's results — never ask the user to supply a raw SKU ID.

**Step 5 — Confirm the assignment**

Call `wait_for_user_ack`:

```yaml
prompt: "This will assign the {skuPartNumber} licence to {displayName} ({upn}). Proceed?"
options:
  - { id: "assign", label: "Assign the licence", kind: "primary" }
  - { id: "cancel", label: "Cancel",             kind: "cancel"  }
```

MUST get explicit confirmation before proceeding. On `cancel` → end the run without assigning.

**Step 6 — Execute the assignment**

`Condition:` only run if Step 5 returned `assign`.

Call `c_entra_assign_license`.

- `status: "not-configured"` → tell the user the gateway isn't set up; contact IT admin
- `status: "failed"` → report `failureReason` (and `httpStatus` if present) and stop
- `status: "ok"` → proceed to verification

**Step 7 — Verify the assignment**

Call `c_entra_get_licenses` again to confirm the new `skuId` appears in the user's licence list.

**Step 8 — Guide the user**

Tell the user:
- The {skuPartNumber} licence has been assigned to {displayName} ({upn})
- Licence-based app features (Outlook, Teams, OneDrive, etc.) may take a few minutes to a few hours to activate
- If the app still shows as unlicensed after that, check for conflicting service plan settings or contact IT
- If they also need app or group access, mention `entra-access-request` as a separate follow-up

---

## Edge cases

- **No `usageLocation` set:** hard stop at Step 1 — never call `c_entra_assign_license` without it, Graph will reject the request.
- **User already has the SKU:** excluded automatically in Step 3's filtering; if nothing remains, tell the user rather than offering a no-op.
- **Tenant out of seats:** Step 3 filters SKUs with `usedSeats >= totalSeats`; if the user's desired SKU has no free seats, tell them to contact IT about purchasing more licences.
- **Account disabled:** licence assignment can still proceed, but the user won't be able to sign in and use it until the account is re-enabled.