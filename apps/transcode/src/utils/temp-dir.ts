// ---------------------------------------------------------------------------
// temp-dir.ts
//
// Manages per-job temporary working directories for ffmpeg input/output.
// Each job gets its own isolated directory so concurrent jobs never collide.
// ---------------------------------------------------------------------------

import { mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Creates a dedicated temp directory for a job.
 * Returns the absolute path.
 *
 * Structure:
 *   <baseTmpDir>/
 *   └── <jobId>/
 *       ├── original.mp4      ← downloaded from S3
 *       ├── index.m3u8        ← ffmpeg output
 *       ├── seg-000.ts
 *       └── seg-001.ts …
 */
export async function createJobTmpDir(baseTmpDir: string, jobId: string): Promise<string> {
  const dir = join(baseTmpDir, jobId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Removes the job's temp directory and all its contents.
 * Always runs — safe to call after both success and failure.
 *
 * Swallows errors so a cleanup failure never masks the original job outcome.
 */
export async function cleanupJobTmpDir(baseTmpDir: string, jobId: string): Promise<void> {
  const dir = join(baseTmpDir, jobId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Intentionally swallowed — cleanup failure is non-fatal
  }
}

/**
 * Returns all .ts segment filenames in the job's temp directory, sorted
 * by segment index so they are uploaded in order.
 */
export async function listSegmentFiles(jobTmpDir: string): Promise<string[]> {
  const entries = await readdir(jobTmpDir);
  return entries
    .filter((f) => f.endsWith(".ts"))
    .sort(); // seg-000.ts, seg-001.ts … lexicographic sort is sufficient
}

/**
 * Returns the absolute path for the downloaded input video within a job dir.
 */
export function inputVideoPath(jobTmpDir: string): string {
  return join(jobTmpDir, "original.mp4");
}