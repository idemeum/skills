/**
 * mcp/skills/triggerSelfServiceInstall.ts — trigger_self_service_install skill
 *
 * Initiates a software install through the device's Self Service
 * catalog (Jamf Self Service, Intune Company Portal, or Munki Managed
 * Software Center). Uses deep-link URL invocations to open the
 * companion app pre-filtered to the requested app — the user clicks
 * Install once, and the catalog's management agent handles the
 * privileged install server-side. No local admin password required.
 *
 * User-scope tool — does NOT route through the privileged helper
 * daemon. The catalogs themselves are the privilege-escalation
 * channel; this tool just opens them in the right place.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/triggerSelfServiceInstall.ts
 */

import { z } from "zod";
import {
  detectCatalog,
  triggerCatalogInstall,
  type CatalogTriggerResult,
  type CatalogType,
} from "./_shared/selfServiceCatalogs";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "trigger_self_service_install",
  description:
    "Initiates a software install through the device's Self Service " +
    "catalog (Jamf, Intune, Munki). Uses a deep-link URL to open the " +
    "companion app pre-filtered to the requested app — the user " +
    "clicks Install once, and the catalog's management agent handles " +
    "the privileged install server-side. Use after " +
    "query_self_service_catalog has detected the catalog.",
  riskLevel:       "low",
  destructive:     false,
  // No consent required: the action is "open the catalog UI to the
  // right page". The user explicitly clicks Install in the catalog
  // itself — that's where the consent decision lives.
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    appIdentifier: z
      .string()
      .min(1)
      .describe(
        "Catalog-internal app identifier returned from " +
        "query_self_service_catalog. For Jamf this is the policy ID; " +
        "for Intune the application ID; for Munki the manifest item " +
        "name. Validated against [A-Za-z0-9._-] to defend against " +
        "shell-metacharacter injection in the deep-link URL.",
      ),
    catalogType: z
      .enum(["jamf", "intune", "munki"])
      .optional()
      .describe(
        "Override the catalog auto-detection. Omit to let the tool " +
        "detect the installed catalog automatically.",
      ),
  },
} as const;

// -- Exported run function ----------------------------------------------------

export async function run({
  appIdentifier,
  catalogType,
}: {
  appIdentifier: string;
  catalogType?: "jamf" | "intune" | "munki";
}): Promise<CatalogTriggerResult> {
  let target: CatalogType;
  if (catalogType) {
    target = catalogType;
  } else {
    const presence = await detectCatalog();
    target = presence.catalog_type;
  }

  return triggerCatalogInstall(target, appIdentifier);
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ appIdentifier: "test-app-123" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
