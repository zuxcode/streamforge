// ---------------------------------------------------------------------------
// temp-dir.ts
//
// Manages per-job temporary working directories for ffmpeg pipelines.
// Each job gets isolated storage to prevent concurrency collisions.
// ---------------------------------------------------------------------------

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/* =========================================================
 * Types
 * ======================================================= */
interface CreateJobTmpDir {
  baseTmpDir: string;
  jobId: string;
  filename: string;
}

/* =========================================================
 * Directory Creation
 * ======================================================= */

/**
 * Creates a dedicated temp directory for a job.
 *
 * Structure:
 *   <baseTmpDir>/
 *   └── <jobId>/
 *       └── <filename>/
 *           ├── <filename>.mp4      ← downloaded from S3
 *           ├── master.m3u8        ← ffmpeg output
 *           └── 1080p/
 *               └── seg-000.ts
 */
export async function createJobTmpDir({
  baseTmpDir,
  jobId,
  filename,
}: CreateJobTmpDir): Promise<string> {
  const dir = join(baseTmpDir, jobId, filename);
  await mkdir(dir, { recursive: true });
  return dir;
}

/* =========================================================
 * Cleanup
 * ======================================================= */

/**
 * Removes a job's temp directory safely.
 * Never throws — cleanup failure is non-fatal.
 */
export async function cleanupJobTmpDir(
  baseTmpDir: string,
  jobId: string,
): Promise<void> {
  const dir = join(baseTmpDir, jobId);

  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // intentionally ignored
  }
}

/* =========================================================
 * Segment Listing
 * =========================================================
 * */

/**
 * Returns all `.ts` segment files in a job directory,
 * sorted numerically (seg-1 < seg-10 correct ordering).
 */
export async function listSegmentFiles(
  jobTmpDir: string,
): Promise<string[]> {
  const glob = new Bun.Glob("**/*.{ts,m3u8}");

  const files = await Array.fromAsync(
    glob.scan({ cwd: jobTmpDir, onlyFiles: true }),
  );

  const filteredFiles = files.filter((f) =>
    f.endsWith(".ts") || f.endsWith("index.m3u8")
  );

  return filteredFiles.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

/* =========================================================
 * Path Helpers
 * ======================================================= */

/**
 * Returns the absolute path for the downloaded input video.
 */
export function inputVideoPath(
  jobTmpDir: string,
  filename: string,
): string {
  return join(jobTmpDir, filename);
}
