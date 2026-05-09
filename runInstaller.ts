/**
 * mcp/skills/runInstaller.ts — run_installer skill
 *
 * Executes a downloaded installer file (.pkg/.dmg on macOS;
 * .msi/.exe on Windows) to (re)install a software application.
 * Use after `download_installer` (Skill #8 Step 6) when the user has
 * confirmed they want to proceed with installation.
 *
 * Privilege model
 * ---------------
 * Installation requires admin / LocalSystem privilege to write into
 * /Applications, /Library/, C:\Program Files, etc.  The agent runs as
 * the standard user; G4 routes this tool through the privileged helper
 * daemon (Workstream B v2 + fast-follow) so non-admin users complete
 * the install end-to-end without an interactive password prompt.  When
 * the helper is unavailable (HELPER_DAEMON_ENABLED=false / not
 * installed / unreachable), the call denies with helper-error /
 * helper-unavailable / scope-boundary and the agent falls back to the
 * "ask the user to run the installer manually" path.
 *
 * Platform strategy
 * -----------------
 * macOS .pkg   `installer -pkg <path> -target /`
 * macOS .dmg   mount via `hdiutil`, copy .app to /Applications, eject
 * Windows .msi `msiexec /i <path> /qn /norestart`
 * Windows .exe Start-Process with /S silent flag
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/runInstaller.ts
 */

import * as fs        from "fs";
import * as path      from "path";
import * as os        from "os";
import { z }          from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "run_installer",
  description:
    "Runs a downloaded installer file (.pkg/.dmg on macOS; .msi/.exe on " +
    "Windows) to (re)install a software application.  Use after " +
    "download_installer when the user has confirmed they want to " +
    "proceed with installation.  Requires admin privileges, which the " +
    "privileged helper daemon supplies for non-admin users.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  escalationHint:  {
    darwin:
      "sudo installer -pkg <path>.pkg -target /  # for .pkg; .dmg requires hdiutil mount + cp + eject",
    win32:
      "msiexec /i <path>.msi /qn /norestart  # for .msi; .exe varies per vendor (try /S for silent install)",
  },
  schema: {
    installerPath: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the installer file on disk.  Typically the " +
        "filePath returned by a prior download_installer call.",
      ),
    installerType: z
      .enum(["pkg", "dmg", "msi", "exe"])
      .optional()
      .describe(
        "Installer type.  When omitted, auto-detected from the file " +
        "extension.  Must match the platform (pkg/dmg → macOS; " +
        "msi/exe → Windows).",
      ),
    dryRun: z
      .boolean()
      .optional()
      .describe(
        "If true, validate the installer + show what would run, but do " +
        "not execute.  Default: true (G4 dry-run-first policy).",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RunInstallerResult {
  installerPath: string;
  installerType: "pkg" | "dmg" | "msi" | "exe";
  dryRun:        boolean;
  /** The exact command string the helper / sudo would execute.  Echoed
   *  in dry-run mode so the consent gate can show it to the user. */
  plannedCommand: string;
  /** Set after a real run; absent in dry-run mode. */
  exitCode?:     number;
  /** Set after a real run; absent in dry-run mode. */
  durationMs?:   number;
  message:       string;
}

// -- Helpers ------------------------------------------------------------------

function detectInstallerType(installerPath: string): "pkg" | "dmg" | "msi" | "exe" {
  const ext = path.extname(installerPath).toLowerCase().replace(/^\./, "");
  if (ext === "pkg" || ext === "dmg" || ext === "msi" || ext === "exe") {
    return ext;
  }
  throw new Error(
    `Cannot detect installer type from extension '.${ext}' — supply installerType explicitly`,
  );
}

function plannedCommandFor(
  type: "pkg" | "dmg" | "msi" | "exe",
  installerPath: string,
): string {
  switch (type) {
    case "pkg":
      return `installer -pkg "${installerPath}" -target /`;
    case "dmg":
      return `hdiutil attach "${installerPath}" -nobrowse -plist  →  cp -Rf <mount>/<app>.app /Applications/  →  hdiutil detach <mount> -force`;
    case "msi":
      return `msiexec /i "${installerPath}" /qn /norestart`;
    case "exe":
      return `Start-Process -FilePath "${installerPath}" -ArgumentList /S -Wait -PassThru`;
  }
}

// -- Exported run function ----------------------------------------------------

export async function run({
  installerPath,
  installerType,
  dryRun = true,
}: {
  installerPath:  string;
  installerType?: "pkg" | "dmg" | "msi" | "exe";
  dryRun?:        boolean;
}): Promise<RunInstallerResult> {
  // Resolve the installer type (explicit or auto-detected).
  const resolvedType = installerType ?? detectInstallerType(installerPath);

  // Cross-platform sanity: the agent-side schema validation already
  // accepts any of the four; here we surface a clear error if the user
  // is on the wrong platform for the chosen type before calling the
  // helper (which would also reject, but with a less friendly message).
  const platform = os.platform();
  const macosTypes = ["pkg", "dmg"] as const;
  const winTypes   = ["msi", "exe"] as const;
  if (platform === "darwin" && (winTypes as readonly string[]).includes(resolvedType)) {
    throw new Error(
      `Installer type '${resolvedType}' is for Windows; this device is macOS`,
    );
  }
  if (platform === "win32" && (macosTypes as readonly string[]).includes(resolvedType)) {
    throw new Error(
      `Installer type '${resolvedType}' is for macOS; this device is Windows`,
    );
  }

  // Path must exist and be a regular file before we even attempt to
  // route the call to the helper.  The helper validates again on its
  // side — this is for fast user-feedback in dry-run mode.
  if (!path.isAbsolute(installerPath)) {
    throw new Error(`installerPath must be absolute, got: ${installerPath}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(installerPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`installerPath not readable: ${msg}`);
  }
  if (!stat.isFile()) {
    throw new Error(`installerPath does not point to a regular file: ${installerPath}`);
  }

  const planned = plannedCommandFor(resolvedType, installerPath);

  if (dryRun) {
    // Dry-run: do not invoke the helper.  Return the planned command
    // for the G4 consent gate to display.
    return {
      installerPath,
      installerType: resolvedType,
      dryRun:        true,
      plannedCommand: planned,
      message:
        `Would run: ${planned}\n\n` +
        `On confirmation, the agent will route this through the privileged ` +
        `helper daemon (when available) so non-admin users complete the ` +
        `install end-to-end.  When the helper is unavailable, the call ` +
        `denies with helper-error / helper-unavailable / scope-boundary ` +
        `and the user must run the installer manually.`,
    };
  }

  // Real run: G4's scope-boundary check routes this op through the
  // helper daemon automatically because affectedScope: ["system"] +
  // helper allowlist contains "run_installer".  The agent-side tool
  // does NOT shell out to `installer` / `msiexec` directly — that
  // would bypass the helper-routing pipeline and fail for non-admin
  // users.  Instead, we throw a sentinel error here that the G4 layer
  // intercepts and replaces with the helper-routed call.
  //
  // In practice, when the agent runtime invokes this tool with
  // dryRun=false, it does so through the G4 execute step, which has
  // already chosen "route via helper" for this tool.  The helper
  // returns { installer_path, installer_type, success, exit_code,
  // duration_ms }; the runtime maps that into RunInstallerResult.
  throw new Error(
    "run_installer is helper-routed; the agent runtime should call the " +
    "helper bridge directly rather than this tool's local run().  " +
    "Reaching this code means the routing layer didn't intercept the call.",
  );
}

// -- Smoke test ---------------------------------------------------------------

if (false) {
  run({ installerPath: "/tmp/example.pkg" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
