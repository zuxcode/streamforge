// ---------------------------------------------------------------------------
// temp-dir.ts
//
// Manages per-job temporary working directories for ffmpeg pipelines.
// Each job gets isolated storage to prevent concurrency collisions.
// ---------------------------------------------------------------------------
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

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
 * ======================================================= */
/**
 * Returns all `.ts` segment files in a job directory (NOT including any
 * per-rendition `index.m3u8` playlists), sorted numerically so
 * seg-1 < seg-10 in the correct order.
 *
 * Per-rendition manifests (`<rendition>/index.m3u8`) are handled by a
 * separate upload step in the processor — with their own S3 key
 * convention and content-type — so they're intentionally excluded here
 * to avoid being uploaded as if they were `.ts` segments.
 */
export async function listSegmentFiles(jobTmpDir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const files = await Array.fromAsync(
    glob.scan({ cwd: jobTmpDir, onlyFiles: true }),
  );

  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Returns all per-rendition `index.m3u8` playlist files in a job
 * directory, along with the rendition name each belongs to (its parent
 * directory name). These need to be uploaded separately from `.ts`
 * segments, with an HLS manifest content-type rather than `video/MP2T`,
 * and without being recorded in the segments array.
 */
export async function listRenditionManifestFiles(
  jobTmpDir: string,
): Promise<Array<{ relativePath: string; rendition: string }>> {
  const glob = new Bun.Glob("*/index.m3u8");
  const files = await Array.fromAsync(
    glob.scan({ cwd: jobTmpDir, onlyFiles: true }),
  );

  return files.map((relativePath) => {
    // const [rendition] = relativePath.split("/");
    const rendition = dirname(relativePath);
    return { relativePath, rendition };
  });
}

/* =========================================================
 * Path Helpers
 * ======================================================= */
/**
 * Returns the absolute path for the downloaded input video.
 */
export function inputVideoPath(jobTmpDir: string, filename: string): string {
  return join(jobTmpDir, filename);
}
