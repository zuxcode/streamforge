// ---------------------------------------------------------------------------
// hls-args.ts
//
// Pure functions for building ffmpeg arguments and deriving HLS output paths.
// No I/O — fully unit-testable without invoking ffmpeg.
// ---------------------------------------------------------------------------

import { join } from "node:path";

export interface HlsEncodeOptions {
  /** Absolute path to the input video file. */
  inputPath: string;

  /** Absolute path to the directory where output files will be written. */
  outputDir: string;

  /** HLS segment duration in seconds. */
  segmentDuration: number;

  /** Output rendition label, e.g. "720p". */
  rendition: string;
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

/**
 * Returns the absolute output paths for the HLS manifest and segments.
 * Called before invoking ffmpeg so the caller knows where output will land.
 */
export function getHlsOutputPaths(outputDir: string): HlsOutputPaths {
  return {
    manifestPath: join(outputDir, "index.m3u8"),
    segmentPattern: join(outputDir, "seg-%03d.ts"),
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
export function buildFfmpegArgs(options: HlsEncodeOptions): string[] {
  const { inputPath, outputDir, segmentDuration } = options;
  const { manifestPath, segmentPattern } = getHlsOutputPaths(outputDir);

  return [
    // Input
    "-i", inputPath,

    // Video: H.264, 720p, constant-rate factor 23 (good quality/size balance)
    "-vf", "scale=-2:720",
    "-c:v", "libx264",
    "-crf", "23",
    "-preset", "veryfast",
    "-profile:v", "main",
    "-level", "3.1",

    // Audio: AAC stereo at 128 kbps
    "-c:a", "aac",
    "-b:a", "128k",
    "-ac", "2",

    // HLS muxer options
    "-f", "hls",
    "-hls_time", String(segmentDuration),
    "-hls_list_size", "0",           // Include all segments in the playlist
    "-hls_playlist_type", "vod",     // VOD: write #EXT-X-ENDLIST on completion
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    "-hls_flags", "append_list",

    // Output manifest path (ffmpeg writes segments based on -hls_segment_filename)
    manifestPath,
  ];
}

/**
 * Derives the expected number of segments from a video duration and segment length.
 * Used after transcoding to validate that all expected segments were produced.
 */
export function expectedSegmentCount(durationSeconds: number, segmentDuration: number): number {
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