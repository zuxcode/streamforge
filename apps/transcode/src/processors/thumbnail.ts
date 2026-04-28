/**
 * thumbnail.ts
 * Extracts a configurable number of JPEG thumbnails from the source video
 * using FFmpeg. Uses Bun.spawn() — no child_process or promisify needed.
 */

import { createLogger } from "@streamforge/logger";
import { mkdir } from "node:fs/promises";
import { join }  from "node:path";

const logger = createLogger("transcode:worker:thumbnail");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Runs a process via Bun.spawn and returns its stdout as a string.
 * Throws with the last lines of stderr if the process exits non-zero.
 */
async function runCapture(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin:  "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) {
    const tail = stderr.split("\n").slice(-10).join("\n");
    throw new Error(`${cmd} exited with code ${code}:\n${tail}`);
  }

  return stdout;
}

/**
 * Returns the duration of a video file in seconds via ffprobe.
 */
async function getDuration(inputPath: string): Promise<number> {
  try {
    const stdout = await runCapture("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);

    const duration = parseFloat(stdout.trim());
    if (Number.isNaN(duration) || duration <= 0) {
      throw new Error(`Could not determine video duration for ${inputPath}`);
    }

    return duration;
  } catch (error) {
    logger.error(error, "Failed to get video duration", "function: getDuration");
    throw error;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ThumbnailOptions {
  inputPath: string;
  outputDir: string;
  /** Number of thumbnails to extract. Default: 3 */
  count?: number;
  /** Thumbnail width in pixels (height scaled automatically). Default: 640 */
  width?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extracts evenly spaced JPEG thumbnails from a video file.
 *
 * Thumbnails are placed at 15 %, 50 %, and 85 % of the video duration to
 * avoid black frames at the very start and end. Each frame is extracted by
 * a separate Bun.spawn("ffmpeg") call so failures are isolated per frame.
 *
 * @returns Absolute paths to the generated thumbnail files.
 *
 * @example
 * const paths = await generateThumbnails({
 *   inputPath: "/tmp/job-123.mp4",
 *   outputDir: "/tmp/job-123",
 *   count: 3,
 *   width: 640,
 * });
 */
export async function generateThumbnails({
  inputPath,
  outputDir,
  count = 1,
  width = 640,
}: ThumbnailOptions): Promise<string[]> {
  // Ensure output directory exists
  try {
    await mkdir(outputDir, { recursive: true });
  } catch (error) {
    logger.error(error, `Failed to create directory ${outputDir}`, "function: generateThumbnails");
    throw error;
  }

  const duration = await getDuration(inputPath);
  logger.info(`Video duration: ${duration.toFixed(1)}s — generating ${count} thumbnail(s)`);

  // 15 % … 85 % spread avoids black frames at the edges
  const offsets =
    count === 1
      ? [0.5]
      : Array.from({ length: count }, (_, i) => 0.15 + (i * 0.7) / (count - 1));

  const thumbnailPaths: string[] = [];

  try {
    for (let i = 0; i < offsets.length; i++) {
      const seekSec  = (duration * offsets[i]).toFixed(3);
      const filename = `thumb_${String(i + 1).padStart(2, "0")}.jpg`;
      const outPath  = join(outputDir, filename);

      logger.info(`Generating thumbnail ${i + 1}/${count} at ${seekSec}s → ${filename}`);

      // Each extraction is a separate spawn so a single bad frame doesn't
      // abort the entire batch and stderr is cleanly isolated per call.
      const proc = Bun.spawn(
        [
          "ffmpeg",
          "-ss",     seekSec,
          "-i",      inputPath,
          "-vframes", "1",
          "-vf",     `scale=${width}:-1`,
          "-q:v",    "3",   // JPEG quality (2 = best, 31 = worst)
          "-y",      outPath,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
      );

      const [stderr, code] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (code !== 0) {
        const tail = stderr.split("\n").slice(-10).join("\n");
        throw new Error(`ffmpeg exited with code ${code} for frame ${i + 1}:\n${tail}`);
      }

      thumbnailPaths.push(outPath);
    }

    logger.info(`✅ Generated ${thumbnailPaths.length} thumbnail(s)`);
    return thumbnailPaths;
  } catch (error) {
    logger.error(error, "Failed to generate thumbnails", "function: generateThumbnails");
    throw error;
  }
}
