/**
 * mcp/skills/runInstaller.ts — run_installer skill
 *
 * Executes a downloaded installer file (.pkg/.dmg on macOS;
 * .msi/.exe/.msix on Windows) to (re)install a software application.
 * Use after `download_installer` (Skill #8 Step 6) when the user has
 * confirmed they want to proceed with installation.
 *
 * Privilege model
 * ---------------
 * .msi/.msix/.pkg/.dmg always write into protected system locations
 * (Program Files, HKLM, /Applications, /Library) and always need admin /
 * LocalSystem privilege. The agent runs as the standard user; G4 routes
 * these through the privileged helper daemon (Workstream B v2 +
 * fast-follow) so non-admin users complete the install end-to-end without
 * an interactive password prompt.  When the helper is unavailable
 * (HELPER_DAEMON_ENABLED=false / not installed / unreachable), the call
 * denies with helper-error / helper-unavailable / scope-boundary and the
 * agent falls back to the "ask the user to run the installer manually" path.
 *
 * .exe is different: a large share of real-world .exe installers (Zoom,
 * Slack/Squirrel, Discord, GitHub Desktop, ...) are self-contained
 * per-user bootstrappers that were never designed to run as LocalSystem —
 * they install into %APPDATA%/%LocalAppData% and need NO elevation at
 * all. Running one of these via the privileged helper installs it into
 * the SYSTEM account's own profile instead of the real user's, and the
 * installer's own "launch the app now" step then fails outright (observed:
 * "Windows cannot access the specified device, path, or file" popping a
 * dialog nobody can dismiss, hanging the run). So .exe tries locally first
 * — see runLocalExeInstall() — and only escalates to the helper if that
 * local attempt demonstrates the installer genuinely needs admin.
 *
 * Platform strategy
 * -----------------
 * macOS .pkg    `installer -pkg <path> -target /`                          (always helper-routed)
 * macOS .dmg    mount via `hdiutil`, copy .app to /Applications, eject      (always helper-routed)
 * Windows .msi  `msiexec /i <path> /qn /norestart`                         (always helper-routed)
 * Windows .exe  execFile(<path>, ["/S"]) as the current user first;        (helper-routed only on
 *               `Start-Process /S` via the helper only on demonstrated       demonstrated need)
 *               elevation need
 * Windows .msix `Add-AppxPackage -Path <path> -AllUsers` — unlike the other (always helper-routed)
 *               three types, this requires the package's signing certificate
 *               to already be trusted on the machine; an otherwise-valid
 *               package fails here if that trust hasn't been provisioned.
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/runInstaller.ts
 */

import * as fs         from "fs";
import * as path       from "path";
import * as os         from "os";
import { execFile }    from "child_process";
import { promisify }   from "util";
import { z }           from "zod";

const execFileAsync = promisify(execFile);

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "run_installer",
  description:
    "Runs a downloaded installer file (.pkg/.dmg on macOS; .msi/.exe/.msix " +
    "on Windows) to (re)install a software application.  Use after " +
    "download_installer when the user has confirmed they want to " +
    "proceed with installation.  Requires admin privileges, which the " +
    "privileged helper daemon supplies for non-admin users.",
  riskLevel:       "high",
  destructive:     true,
  requiresConsent: true,
  supportsDryRun:  true,
  affectedScope:   ["system"],
  auditRequired:   true,
  // Default G4 step timeout (60s) is routinely too short for a real
  // install — observed timing out on Zoom/Teams/Slack reinstalls in the
  // field. The underlying helper daemon already budgets up to 600s per
  // command (see run_installer.rs PER_COMMAND_TIMEOUT); this is the outer
  // G4 ceiling, forwarded to the helper CLI roundtrip too (see
  // runViaHelper in execution.ts) so both layers agree.
  timeoutMs:       120_000,
  escalationHint:  {
    darwin:
      "sudo installer -pkg <path>.pkg -target /  # for .pkg; .dmg requires hdiutil mount + cp + eject",
    win32:
      "msiexec /i <path>.msi /qn /norestart  # for .msi; .exe varies per vendor (try /S for silent install); " +
      "Add-AppxPackage -Path <path>.msix -AllUsers  # for .msix — requires the package's signing certificate " +
      "to already be trusted on the machine",
  },
  outputKeys: ["installerPath","installerType","dryRun","plannedCommand","exitCode","durationMs","message"],
  schema: {
    // snake_case keys: this tool routes its real run through the privileged
    // helper, whose `struct Params` is snake_case (`installer_path`,
    // `installer_type`) per the documented wire contract (HELPER-IPC-PROTOCOL.md
    // / HELPER-HANDLERS.md). G4 forwards executor params verbatim, so the schema
    // keys MUST match the helper field names exactly.
    installer_path: z
      .string()
      .min(1)
      .describe(
        "Absolute path to the installer file on disk.  Typically the " +
        "filePath returned by a prior download_installer call.",
      ),
    installer_type: z
      .enum(["pkg", "dmg", "msi", "exe", "msix"])
      .nullable().optional()
      .describe(
        "Installer type.  When omitted, auto-detected from the file " +
        "extension.  Must match the platform (pkg/dmg → macOS; " +
        "msi/exe/msix → Windows).",
      ),
    dryRun: z
      .boolean()
      .nullable().optional()
      .describe(
        "If true, validate the installer + show what would run, but do " +
        "not execute.  Default: true (G4 dry-run-first policy).",
      ),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface RunInstallerResult {
  installerPath: string;
  installerType: "pkg" | "dmg" | "msi" | "exe" | "msix";
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

function detectInstallerType(installerPath: string): "pkg" | "dmg" | "msi" | "exe" | "msix" {
  const ext = path.extname(installerPath).toLowerCase().replace(/^\./, "");
  if (ext === "pkg" || ext === "dmg" || ext === "msi" || ext === "exe" || ext === "msix") {
    return ext;
  }
  throw new Error(
    `Cannot detect installer type from extension '.${ext}' — supply installerType explicitly`,
  );
}

function plannedCommandFor(
  type: "pkg" | "dmg" | "msi" | "exe" | "msix",
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
    case "msix":
      return `Add-AppxPackage -Path "${installerPath}" -AllUsers`;
  }
}

// -- Local (non-elevated) .exe install path -----------------------------------

/**
 * Thrown when a local, non-elevated install attempt demonstrates that the
 * installer genuinely needs administrator privileges, so the G4 execution
 * guard knows to retry via the privileged helper instead of surfacing this
 * as a normal tool failure.
 *
 * Classified by `.name`, not `instanceof`: this module is compiled into
 * dist/skills/ and loaded via require() at runtime, separately from the
 * main Electron bundle that contains G4 — two independently compiled
 * module graphs never share a class reference, so an instanceof check
 * across that boundary would never match even for the "same" class.
 */
export class NeedsElevationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsElevationError";
  }
}

/**
 * Best-effort signal that a failed spawn was rejected specifically because
 * the target .exe requires elevation, as opposed to any other install
 * failure (bad download, wrong architecture, corrupt installer, the
 * installer ran but exited non-zero for its own reasons). A failed
 * CreateProcess call (couldn't start at all) surfaces to Node as an errno
 * string code (EACCES/EPERM) rather than a numeric exit code, which is
 * the generic "no permission to do this" signal Node uses across
 * platforms — a nonzero numeric `.code` means the process DID start and
 * exited on its own, which is a real install failure, not an elevation
 * issue, and must not be swallowed into a helper retry.
 *
 * NOT yet verified against a real elevation-required installer on Windows
 * (this is Windows-only runtime behaviour and development happens on
 * macOS) — if this under- or over-triggers in the field, tighten or
 * loosen this pattern rather than the call site's escalation logic.
 */
function looksLikeElevationRequired(err: unknown): boolean {
  const e = err as (NodeJS.ErrnoException & { message?: string }) | undefined;
  if (!e) return false;
  if (e.code === "EACCES" || e.code === "EPERM") return true;
  return /elevation|ERROR_ELEVATION_REQUIRED|\b740\b/i.test(e.message ?? "");
}

/**
 * Runs a Windows .exe installer directly via child_process.execFile — NOT
 * PowerShell's Start-Process — as the current, non-elevated process.
 *
 * Deliberately bypasses PowerShell/ShellExecute: ShellExecute honours a
 * target's "requireAdministrator" manifest by popping an interactive UAC
 * consent prompt, which would hang indefinitely here (there is nobody to
 * click it in an automation context — this is exactly how the Zoom
 * install hung when run as SYSTEM). execFile calls CreateProcess
 * directly, which has no such manifest-driven auto-elevation behaviour: a
 * binary that truly requires admin fails the call outright and
 * synchronously — precisely the signal looksLikeElevationRequired() is
 * watching for. A binary that does NOT require admin (the common case for
 * consumer installers) just runs, as the real interactive user, into
 * their own profile — sidestepping the SYSTEM-profile mismatch entirely.
 *
 * Returns the exit code on success (always 0 — execFile only resolves
 * when the child exits 0). Throws NeedsElevationError when the spawn
 * itself was rejected for a permission reason; throws a plain Error for
 * any other failure (real install failure — must not retry via helper).
 */
async function runLocalExeInstall(
  installerPath: string,
  signal?:       AbortSignal,
): Promise<number> {
  try {
    await execFileAsync(installerPath, ["/S"], { signal });
    return 0;
  } catch (err) {
    if (looksLikeElevationRequired(err)) {
      throw new NeedsElevationError(
        `"${installerPath}" appears to require administrator privileges ` +
        `(local non-elevated launch failed: ${(err as Error).message})`,
      );
    }
    throw new Error(`Local install failed: ${(err as Error).message}`);
  }
}

// -- Exported run function ----------------------------------------------------

export async function run(
  {
    installer_path: installerPath,
    installer_type: installerType,
    dryRun = true,
  }: {
    installer_path:  string;
    installer_type?: "pkg" | "dmg" | "msi" | "exe" | "msix";
    dryRun?:         boolean;
  },
  ctx?: { signal?: AbortSignal },
): Promise<RunInstallerResult> {
  // Resolve the installer type (explicit or auto-detected).
  const resolvedType = installerType ?? detectInstallerType(installerPath);

  // Cross-platform sanity: the agent-side schema validation already
  // accepts any of the five; here we surface a clear error if the user
  // is on the wrong platform for the chosen type before calling the
  // helper (which would also reject, but with a less friendly message).
  const platform = os.platform();
  const macosTypes = ["pkg", "dmg"] as const;
  const winTypes   = ["msi", "exe", "msix"] as const;
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

  const isLocalFirstExe = resolvedType === "exe" && platform === "win32";

  if (dryRun) {
    // Dry-run: do not invoke the helper.  Return the planned command
    // for the G4 consent gate to display.
    return {
      installerPath,
      installerType: resolvedType,
      dryRun:        true,
      plannedCommand: planned,
      message: isLocalFirstExe
        ? `Would run: ${planned}\n\n` +
          `Most .exe installers (Zoom, Slack, Discord, etc.) are per-user ` +
          `and don't need admin — this will first be attempted directly as ` +
          `the current user.  Only if that demonstrates the installer genuinely ` +
          `needs elevation will the agent retry it through the privileged helper ` +
          `daemon (when available).`
        : `Would run: ${planned}\n\n` +
          `On confirmation, the agent will route this through the privileged ` +
          `helper daemon (when available) so non-admin users complete the ` +
          `install end-to-end.  When the helper is unavailable, the call ` +
          `denies with helper-error / helper-unavailable / scope-boundary ` +
          `and the user must run the installer manually.`,
    };
  }

  // .exe: try running it directly, as the current (non-elevated) user,
  // before ever involving the privileged helper — see runLocalExeInstall's
  // doc comment for why (per-user installers, SYSTEM-profile mismatch).
  // Throwing NeedsElevationError here is a signal G4's executeStep acts
  // on to retry via the helper; any other error is a real install failure
  // and propagates normally.
  if (isLocalFirstExe) {
    const started  = Date.now();
    const exitCode = await runLocalExeInstall(installerPath, ctx?.signal);
    return {
      installerPath,
      installerType:  resolvedType,
      dryRun:         false,
      plannedCommand: planned,
      exitCode,
      durationMs:     Date.now() - started,
      message:        `Installed successfully, no elevation required: ${planned}`,
    };
  }

  // Real run for .msi/.msix/.pkg/.dmg: G4's scope-boundary check routes
  // this op through the helper daemon automatically because
  // affectedScope: ["system"] + helper allowlist contains
  // "run_installer".  The agent-side tool does NOT shell out to
  // `msiexec` / `installer` directly — that would bypass the
  // helper-routing pipeline and fail for non-admin users.  Instead, we
  // throw a sentinel error here that the G4 layer intercepts and
  // replaces with the helper-routed call.
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
  run({ installer_path: "/tmp/example.pkg" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
