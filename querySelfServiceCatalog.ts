/**
 * mcp/skills/querySelfServiceCatalog.ts — query_self_service_catalog skill
 *
 * Detects which Self Service catalog (Jamf Self Service, Intune
 * Company Portal, or Munki Managed Software Center) is installed on
 * the device, and best-effort enumerates apps available through it.
 * Used by Skill #8 (software-reinstall) so non-admin users on
 * managed devices can install through the corp catalog instead of
 * needing local admin.
 *
 * Read-only / user-scope tool — does NOT route through the privileged
 * helper daemon.  Catalogs handle privilege escalation server-side
 * via their own management agents.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/querySelfServiceCatalog.ts
 */

import { z } from "zod";
import {
  detectCatalog,
  queryCatalog,
  type CatalogQueryResult,
} from "./_shared/selfServiceCatalogs";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "query_self_service_catalog",
  description:
    "Detects which Self Service catalog (Jamf Self Service, Intune " +
    "Company Portal, or Munki Managed Software Center) is installed " +
    "on the device, and best-effort lists available apps. Use during " +
    "software-reinstall Step 4 (after check_mdm_enrollment) to surface " +
    "the non-admin install path for managed enterprise users. " +
    "Read-only — does not modify any state.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {},
} as const;

// -- Exported run function ----------------------------------------------------

export async function run(_args: Record<string, never> = {}): Promise<CatalogQueryResult> {
  const presence = await detectCatalog();
  return queryCatalog(presence);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run()
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
