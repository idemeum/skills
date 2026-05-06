/**
 * mcp/skills/openIdpSsprPortal.ts — open_idp_sspr_portal
 *
 * Deep-links the user's default browser to the IDP's self-service
 * password-reset URL.  The user completes the reset in the IDP's own UI
 * (with whatever MFA / recovery factors the IDP enforces) — the agent
 * never sees the password.
 *
 * After this tool returns, the parent skill emits a wait_for_user_ack
 * plan step so the run blocks until the user confirms "done".
 *
 * Platform strategy
 * -----------------
 * darwin  `open <url>`
 * win32   `cmd /c start "" "<url>"` (empty title is required for start)
 *
 * Dry-run returns the URL that would be opened without actually opening
 * it, so G4's dry-run preview shows the user exactly where they'll land.
 */

import { z } from "zod";
import { isDarwin, isWin32, execAsync } from "./_shared/platform";
import { buildSsprUrl, idpDisplayName, type Idp } from "./_shared/idp";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "open_idp_sspr_portal",
  description:
    "Opens the IDP's self-service password-reset URL in the user's default " +
    "browser. Supports Okta (requires a tenant slug), Microsoft Entra, and " +
    "Google Workspace. The user completes the reset in the IDP's own UI — " +
    "the agent does NOT see the password. Use dryRun:true to preview the " +
    "URL without opening a browser window.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  true,
  affectedScope:   ["user"],
  auditRequired:   true,
  schema: {
    idp: z
      .enum(["okta", "entra", "google", "unknown"])
      .describe("IDP identifier from detect_identity_provider."),
    tenant: z
      .string()
      .optional()
      .describe("Okta tenant slug (ignored for Entra/Google)."),
    dryRun: z
      .boolean()
      .optional()
      .describe("When true, return the resolved URL without opening a browser."),
  },
} as const;

// -- Types --------------------------------------------------------------------

export interface OpenSsprResult {
  idp:       Idp;
  tenant:    string | null;
  url:       string | null;
  /** "opened" | "dry-run" | "not-applicable" */
  status:    "opened" | "dry-run" | "not-applicable";
  idpLabel:  string;
  message:   string;
}

// -- Implementation -----------------------------------------------------------

async function openUrl(url: string): Promise<void> {
  // URL is validated before we get here (see buildSsprUrl + the validation
  // pass below), but do a final sanity check so a forged URL cannot reach
  // the shell.
  if (!/^https:\/\/[a-zA-Z0-9._/\-]+(\?[^ \n"'`]*)?$/.test(url)) {
    throw new Error(`Refusing to open URL with suspicious characters: ${url}`);
  }
  if (isDarwin()) {
    await execAsync(`open "${url}"`, { timeout: 5_000 });
    return;
  }
  if (isWin32()) {
    // `start` requires a blank title ("") as first arg when the URL has spaces.
    await execAsync(`cmd /c start "" "${url}"`, { timeout: 5_000 });
    return;
  }
  throw new Error("Unsupported platform — cannot open browser.");
}

// Exported for unit tests.
export const __testing = { openUrl };

// -- Exported run function ----------------------------------------------------

export async function run({
  idp,
  tenant,
  dryRun = false,
}: {
  idp:     Idp;
  tenant?: string;
  dryRun?: boolean;
}): Promise<OpenSsprResult> {
  const idpLabel = idpDisplayName(idp);

  if (idp === "unknown") {
    return {
      idp, tenant: tenant ?? null, url: null,
      status:   "not-applicable",
      idpLabel,
      message:  "IDP is unknown — cannot open a self-service portal. Escalate to helpdesk.",
    };
  }

  const url = buildSsprUrl(idp, tenant);
  if (!url) {
    return {
      idp, tenant: tenant ?? null, url: null,
      status:   "not-applicable",
      idpLabel,
      message:  `No self-service portal URL available for ${idpLabel}.`,
    };
  }

  if (dryRun) {
    return {
      idp, tenant: tenant ?? null, url,
      status:   "dry-run",
      idpLabel,
      message:  `Would open ${idpLabel}'s password-reset page at ${url}.`,
    };
  }

  await openUrl(url);
  return {
    idp, tenant: tenant ?? null, url,
    status:   "opened",
    idpLabel,
    message:  `Opened ${idpLabel}'s password-reset page in your default browser.`,
  };
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ idp: "okta", tenant: "acme", dryRun: true })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
