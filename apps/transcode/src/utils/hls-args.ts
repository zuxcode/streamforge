// ---------------------------------------------------------------------------
// hls-args.ts
//
// Pure functions for building ffmpeg arguments and deriving HLS output paths.
// No I/O — fully unit-testable without invoking ffmpeg.
// ---------------------------------------------------------------------------

import { createLogger } from "@streamforge/logger";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface Rendition {
  /** Human-readable label, e.g. "1080p". Also used as filename prefix. */
  name: string;
  width: number;
  height: number;
  /** FFmpeg target video bitrate, e.g. "5000k" */
  videoBr: string;
  /** FFmpeg maxrate cap */
  maxRate: string;
  /** FFmpeg VBV buffer size */
  bufSize: string;
  /** FFmpeg target audio bitrate, e.g. "192k" */
  audioBr: string;
  /** HLS master playlist BANDWIDTH value in bits per second */
  bandwidth: number;
}

export interface SourceResolution {
  width: number;
  height: number;
}

export interface HlsEncodeOptions {
  /** Absolute path to the input video file. */
  inputPath: string;

  /** Absolute path to the directory where output files will be written. */
  outputDir: string;

  /** HLS segment duration in seconds. */
  segmentDuration: number;

  /** Output rendition label, e.g. "720p". */
  rendition:  Rendition;
}

export interface HlsOutputPaths {
  /** Absolute path to the .m3u8 manifest. */
  manifestPath: string;

  /**
   * Glob-style pattern used internally by ffmpeg to name segments.
   * e.g. /tmp/streamforge/job-123/seg-%03d.ts
   */
  segmentPattern: string;
}

const logger = createLogger("transcode:worker:hls");

export const RENDITIONS: readonly Rendition[] = [
  // {
  //   name: "1080p",
  //   width: 1920,
  //   height: 1080,
  //   videoBr: "5000k",
  //   maxRate: "5350k",
  //   bufSize: "7500k",
  //   audioBr: "192k",
  //   bandwidth: 5_192_000,
  // },
  // {
  //   name: "720p",
  //   width: 1280,
  //   height: 720,
  //   videoBr: "2800k",
  //   maxRate: "2996k",
  //   bufSize: "4200k",
  //   audioBr: "128k",
  //   bandwidth: 2_928_000,
  // },
  // {
  //   name: "480p",
  //   width: 854,
  //   height: 480,
  //   videoBr: "1400k",
  //   maxRate: "1498k",
  //   bufSize: "2100k",
  //   audioBr: "128k",
  //   bandwidth: 1_528_000,
  // },
  {
    name: "360p",
    width: 640,
    height: 360,
    videoBr: "800k",
    maxRate: "856k",
    bufSize: "1200k",
    audioBr: "96k",
    bandwidth: 896_000,
  },
] as const;

/**
 * Probes the source file for its native resolution using ffprobe.
 * Returns `null` on any failure so callers can fall back to encoding all renditions.
 */
export async function probeResolution(
  inputPath: string,
): Promise<SourceResolution | null> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        inputPath,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );

    const text = await new Response(proc.stdout).text();
    await proc.exited;

    const parts = text.trim().split(",");
    if (parts.length === 2) {
      const width = parseInt(parts[0], 10);
      const height = parseInt(parts[1], 10);
      if (!Number.isNaN(width) && !Number.isNaN(height)) {
        return { width, height };
      }
    }
  } catch (error) {
    logger.error(error, "ffprobe not found or file unreadable");
    // ffprobe not found or file unreadable — handled by caller
  }
  return null;
}

function getH264Level(height: number): string {
  if (height >= 1080) return "4.1";
  if (height >= 720) return "3.1";
  if (height >= 480) return "3.0";
  return "3.0";
}

/**
 * Returns the absolute output paths for the HLS manifest and segments.
 * Called before invoking ffmpeg so the caller knows where output will land.
 */
export async function getHlsOutputPaths(
  outputDir: string,
  rendition: Rendition,
): Promise<HlsOutputPaths> {
  const renditionDir = join(outputDir, rendition.name);
  await mkdir(renditionDir, { recursive: true });

  return {
    manifestPath: join(renditionDir, "index.m3u8"),
    segmentPattern: join(renditionDir, "seg-%03d.ts"),
  };
}

/**
 * Builds the ffmpeg argument array for HLS transcoding.
 *
 * Targets a single 720p rendition with H.264 video and AAC audio, which
 * is universally supported by HLS players without additional codec config.
 *
 * Segment naming matches the s3Keys.segment() convention:
 *   seg-000.ts, seg-001.ts, seg-002.ts …
 */
export async function buildFfmpegArgs(
  options: HlsEncodeOptions,
): Promise<string[]> {
  const { inputPath, outputDir, segmentDuration, rendition } = options;
  const { manifestPath, segmentPattern } = await getHlsOutputPaths(
    outputDir,
    rendition,
  );


  return [
  "-i", inputPath,

  "-c:v", "libx264",
  "-preset", "veryfast",
  "-profile:v", "main",
  "-level", getH264Level(rendition.height),

  "-vf",
  `scale=${rendition.width}:${rendition.height}:force_original_aspect_ratio=decrease,` +
  `pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2`,

  // ✅ Use bitrate control (not CRF)
  "-b:v", rendition.videoBr,
  "-maxrate", rendition.maxRate,
  "-bufsize", rendition.bufSize,

  // ✅ Critical for HLS
  "-g", "48",
  "-keyint_min", "48",
  "-sc_threshold", "0",

  "-c:a", "aac",
  "-b:a", rendition.audioBr,
  "-ac", "2",

  "-f", "hls",
  "-hls_time", String(segmentDuration),
  "-hls_playlist_type", "vod",
  "-hls_list_size", "0",
  "-hls_flags", "independent_segments",
  "-hls_segment_filename", segmentPattern,

  manifestPath,
];
}

/**
 * Derives the expected number of segments from a video duration and segment length.
 * Used after transcoding to validate that all expected segments were produced.
 */
export function expectedSegmentCount(
  durationSeconds: number,
  segmentDuration: number,
): number {
  return Math.ceil(durationSeconds / segmentDuration);
}

/**
 * Returns the zero-based segment index from a segment filename.
 * e.g. "seg-007.ts" → 7
 */
export function segmentIndexFromFilename(filename: string): number | null {
  const match = filename.match(/seg-(\d+)\.ts$/);
  if (!match || !match[1]) return null;
  return parseInt(match[1], 10);
}

/**
 * Spawns FFmpeg via Bun.spawn and streams stderr line-by-line for progress
 * logging. Rejects with a descriptive error if the process exits non-zero.
 */
export async function runFfmpeg(args: string[]): Promise<void> {
    const proc = Bun.spawn(["ffmpeg", ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });

    // Stream stderr without buffering the whole output in memory
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    let stderrTail = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // Keep a rolling window of the last 25 lines for error reporting
        stderrTail = `${stderrTail}${chunk}`.split("\n").slice(-25).join("\n");

        for (const line of chunk.split("\n")) {
            if (line.includes("frame=") || line.includes("speed=")) {
                logger.debug(`ffmpeg: ${line.trim()}`);
            }
        }
    }

    const code = await proc.exited;
    if (code !== 0) {
        const tail = stderrTail.split("\n").slice(-10).join("\n");
        throw new Error(`ffmpeg exited with code ${code}:\n${tail}`);
    }
}

// ─── Master playlist ──────────────────────────────────────────────────────────

export function writeMasterPlaylist(
    outputDir: string,
    renditions: Rendition[],
): string {
    const masterPath = join(outputDir, "master.m3u8");

    const lines: string[] = ["#EXTM3U", "#EXT-X-VERSION:3", ""];
    for (const r of renditions) {
        lines.push(
            `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height},` +
                `CODECS="avc1.4D401F,mp4a.40.2",NAME="${r.name}"`,
            `${join(r.name, "index.m3u8")}`,
        );
    }

    writeFileSync(masterPath, lines.join("\n"));
    return masterPath;
}

