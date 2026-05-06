/**
 * mcp/skills/downloadInstaller.ts — download_installer skill
 *
 * Downloads an application installer from a HTTPS URL to a temporary
 * directory. Validates integrity via SHA-256 checksum if provided.
 * Use as the first step of a software reinstall workflow.
 *
 * Platform strategy
 * -----------------
 * darwin & win32  Node.js https.get() streaming to os.tmpdir()
 *                 SHA-256 via crypto.createHash if checksumSha256 provided
 *
 * Smoke test
 *   npx tsx -r dotenv/config mcp/skills/downloadInstaller.ts
 */

import * as os       from "os";
import * as nodePath from "path";
import * as fs       from "fs";
import * as https    from "https";
import * as crypto   from "crypto";
import { z }         from "zod";

// -- Meta ---------------------------------------------------------------------

export const meta = {
  name: "download_installer",
  description:
    "Downloads an application installer from a HTTPS URL to a temporary directory. " +
    "Validates integrity via SHA-256 checksum if provided. " +
    "Use as the first step of a software reinstall workflow.",
  riskLevel:       "low",
  destructive:     false,
  requiresConsent: false,
  supportsDryRun:  false,
  affectedScope:   ["user"],
  auditRequired:   false,
  schema: {
    url: z
      .string()
      .describe("HTTPS URL to the installer (.dmg, .pkg, .exe, .msi)"),
    filename: z
      .string()
      .optional()
      .describe("Local filename. Defaults to the filename from the URL"),
    checksumSha256: z
      .string()
      .optional()
      .describe("Expected SHA-256 hash for integrity validation"),
  },
} as const;

// -- Types --------------------------------------------------------------------

interface DownloadResult {
  localPath:        string;
  fileSizeMb:       number;
  checksumValid:    boolean | null;
  checksumProvided: boolean;
  message:          string;
}

// -- Download implementation --------------------------------------------------

async function downloadFile(
  url:            string,
  destPath:       string,
  checksumSha256?: string,
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    const hash   = checksumSha256 ? crypto.createHash("sha256") : null;
    const output = fs.createWriteStream(destPath);
    let bytesDownloaded = 0;

    const request = https.get(url, (res) => {
      // Follow redirects (up to 5)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        output.close();
        fs.unlink(destPath, () => {});
        // Recursively follow redirect
        downloadFile(res.headers.location, destPath, checksumSha256)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        output.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`HTTP ${res.statusCode ?? "unknown"} from ${url}`));
        return;
      }

      res.on("data", (chunk: Buffer) => {
        bytesDownloaded += chunk.length;
        if (hash) hash.update(chunk);
      });

      res.pipe(output);

      output.on("finish", () => {
        output.close();
        const fileSizeMb = Math.round((bytesDownloaded / (1024 * 1024)) * 100) / 100;

        let checksumValid: boolean | null = null;
        let message = `Downloaded ${fileSizeMb} MB to ${destPath}`;

        if (checksumSha256 && hash) {
          const actualHash = hash.digest("hex").toLowerCase();
          const expected   = checksumSha256.toLowerCase();
          checksumValid    = actualHash === expected;
          if (!checksumValid) {
            fs.unlink(destPath, () => {});
            message = `SHA-256 mismatch. Expected: ${expected}. Got: ${actualHash}. File removed.`;
          } else {
            message = `Downloaded ${fileSizeMb} MB. SHA-256 verified OK.`;
          }
        }

        resolve({
          localPath:        checksumValid === false ? "" : destPath,
          fileSizeMb,
          checksumValid,
          checksumProvided: !!checksumSha256,
          message,
        });
      });

      output.on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });

    request.setTimeout(300_000, () => {
      request.destroy();
      fs.unlink(destPath, () => {});
      reject(new Error("Download timed out after 5 minutes"));
    });
  });
}

// -- Exported run function ----------------------------------------------------

export async function run({
  url,
  filename,
  checksumSha256,
}: {
  url:             string;
  filename?:       string;
  checksumSha256?: string;
}): Promise<DownloadResult> {
  // Security: only HTTPS
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`[download_installer] Invalid URL: ${url}`);
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error(
      `[download_installer] Only HTTPS URLs are allowed. Got: ${parsedUrl.protocol}`,
    );
  }

  const resolvedFilename = filename ?? (nodePath.basename(parsedUrl.pathname) || "installer");
  const destPath         = nodePath.join(os.tmpdir(), resolvedFilename);

  return downloadFile(url, destPath, checksumSha256);
}

// -- CLI smoke test -----------------------------------------------------------

if (false) {
  run({ url: "https://example.com/installer.dmg" })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch((err: Error) => { console.error(err.message); process.exit(1); });
}
