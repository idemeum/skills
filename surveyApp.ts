/**
 * mcp/skills/surveyApp.ts — survey_app
 *
 * Coarse-grained read of one application: whether it is installed, whether its
 * bundle is intact, and what system permissions it holds.
 *
 * Why coarse
 * ----------
 * `software-reinstall` opens with all three unconditionally, because none of
 * them alone distinguishes the cases it has to tell apart — an app that was
 * never installed, one whose binary is corrupt, and one that is fine but has
 * been denied a permission it needs. Three plan steps, three executor
 * iterations, one conclusion.
 *
 * The fine-grained tools remain registered and are NOT deprecated.
 *
 * What it refuses to decide
 * -------------------------
 * Whether to reinstall. `signatureValid: false` means the bundle is corrupt and
 * non-destructive fixes are pointless; a denied permission means the opposite.
 * Which of those the user is actually reporting is the skill's call, and there
 * is a user gate in the workflow for exactly that choice.
 *
 * Ordering note: integrity and permissions both need the app to exist, so this
 * looks it up first and skips them when it does not — reporting `installed:
 * false` rather than two spurious not-found results.
 */

import { run as listInstalledApps }   from "./listInstalledApps";
import { run as checkAppIntegrity }   from "./checkAppIntegrity";
import {
  run as checkAppPermissions,
  meta as permissionsMeta,
} from "./checkAppPermissions";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "survey_app",
  description:
    "Reads one application's state in one call: whether it is installed, whether " +
    "its code signature and Gatekeeper approval are intact, and which system " +
    "permissions it has been granted or denied. Read-only. Use at the start of an " +
    "application-repair workflow instead of list_installed_apps, " +
    "check_app_integrity and check_app_permissions separately.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  outputKeys: [
    "appName",
    "installed",
    "matches",
    "integrity",
    "permissions",
  ],
  // Borrowed so the app-name validation cannot drift from the tools called.
  schema: { appName: permissionsMeta.schema.appName },
} as const;

// -- Types --------------------------------------------------------------------

export interface SurveyAppResult {
  appName: string;
  /** True when the catalogue lookup matched at least one installed app. */
  installed: boolean;
  /**
   * Every catalogue match, raw. More than one means the name was ambiguous —
   * act on none of them until the user has picked, exactly as a duplicate MDM
   * serial is treated.
   */
  matches: unknown[];
  /**
   * Code signature and Gatekeeper state. Null when the app is not installed —
   * absence, not a failed check.
   */
  integrity: unknown | null;
  /** Granted / denied system permissions. Null when the app is not installed. */
  permissions: unknown | null;
}

/**
 * The bundle path of the single unambiguous match, or null.
 *
 * Deliberately null on more than one match: an ambiguous name must not have one
 * arbitrary candidate's path silently attached to it, for the same reason a
 * duplicate MDM serial is refused rather than guessed. Integrity then falls back
 * to its own by-name lookup and the caller still sees every match.
 *
 * Exported for tests.
 */
export function bundlePath(matches: unknown[]): string | null {
  if (matches.length !== 1) return null;
  const p = (matches[0] as { path?: unknown } | null)?.path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

// -- Implementation -----------------------------------------------------------

export async function run(
  { appName }: { appName: string },
): Promise<SurveyAppResult> {
  const listed = await listInstalledApps({ filter: appName });
  const matches = (listed.apps ?? []) as unknown[];

  if (matches.length === 0) {
    return { appName, installed: false, matches, integrity: null, permissions: null };
  }

  // The listing has already resolved the real bundle — hand its path to the
  // integrity probe rather than letting it search again by name.
  //
  // checkAppIntegrity's own lookup is an exact `<name>.app` match
  // (findAppDarwin), so any app whose bundle directory differs from the name a
  // user types comes back `found: false` while the listing above says
  // `installed: true` — a result that contradicts itself. Observed 2026-09-04:
  // "Zoom" installs to /Applications/zoom.us.app, integrity reported not-found,
  // `signatureValid` landed `null`, and software-reinstall read that as "the
  // binary is not intact", skipped its whole non-destructive branch and called
  // `uninstall_app` on a healthy install. Only an unavailable helper stopped it.
  const resolvedPath = bundlePath(matches);

  // Both need the app present; run them together once that is established.
  const [integrity, permissions] = await Promise.all([
    checkAppIntegrity(resolvedPath ? { appName, appPath: resolvedPath } : { appName }),
    checkAppPermissions({ appName }),
  ]);

  return { appName, installed: true, matches, integrity, permissions };
}
