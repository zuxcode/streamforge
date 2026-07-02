// ---------------------------------------------------------------------------
// error-classifier.ts
//
// Classifies errors as retriable (BullMQ will re-enqueue) or terminal
// (job is permanently failed and must not be retried).
//
// Retriable:  transient infrastructure issues — Redis blips, S3 timeouts,
//             network errors, temporary resource exhaustion.
//
// Terminal:   problems with the job payload or input file itself — corrupt
//             video, unsupported codec, missing S3 key, invalid job data.
//             Retrying will produce the same failure every time.
// ---------------------------------------------------------------------------

import { StorageKeyNotFoundError } from "@streamforge/storage";

export type ErrorClass = "retriable" | "terminal";

export interface ClassifiedError {
  class: ErrorClass;
  code: string;
  message: string;
  originalError: unknown;
}

/**
 * ffmpeg exit codes that indicate a problem with the *input file* rather
 * than a transient system issue. These should not be retried.
 */
const TERMINAL_FFMPEG_EXIT_CODES = new Set([
  1,   // Generic error (usually codec/format issue)
  69,  // ENOSYS — operation not supported (unsupported codec)
]);

/**
 * Error message substrings that indicate a terminal ffmpeg failure.
 */
const TERMINAL_FFMPEG_PATTERNS = [
  "invalid data found",
  "no such file or directory",
  "unsupported codec",
  "moov atom not found",    // Truncated/corrupt mp4
  "end of file",            // Truncated input
  "invalid argument",
  "decoder not found",
];

export function classifyError(err: unknown): ClassifiedError {
  // ── S3 key missing — the job references a file that doesn't exist ─────────
  if (err instanceof StorageKeyNotFoundError) {
    return {
      class: "terminal",
      code: "S3_KEY_NOT_FOUND",
      message: `Input video not found in S3: ${err.key}`,
      originalError: err,
    };
  }

  // ── ffmpeg process errors ──────────────────────────────────────────────────
  if (err instanceof FfmpegError) {
    const isTerminal =
      TERMINAL_FFMPEG_EXIT_CODES.has(err.exitCode) ||
      TERMINAL_FFMPEG_PATTERNS.some((p) =>
        err.stderr.toLowerCase().includes(p)
      );

    return {
      class: isTerminal ? "terminal" : "retriable",
      code: isTerminal ? "FFMPEG_TERMINAL_ERROR" : "FFMPEG_TRANSIENT_ERROR",
      message: `ffmpeg exited with code ${err.exitCode}`,
      originalError: err,
    };
  }

  // ── Network / timeout errors — retriable ──────────────────────────────────
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("econnrefused") ||
      msg.includes("econnreset") ||
      msg.includes("etimedout") ||
      msg.includes("socket hang up") ||
      msg.includes("network") ||
      msg.includes("timeout")
    ) {
      return {
        class: "retriable",
        code: "NETWORK_ERROR",
        message: err.message,
        originalError: err,
      };
    }
  }

  // ── Unknown errors — treat as retriable to avoid silent data loss ─────────
  return {
    class: "retriable",
    code: "UNKNOWN_ERROR",
    message: err instanceof Error ? err.message : String(err),
    originalError: err,
  };
}

// ---------------------------------------------------------------------------
// FfmpegError — thrown by the processor when ffmpeg exits non-zero
// ---------------------------------------------------------------------------

export class FfmpegError extends Error {
  public readonly exitCode: number;
  public readonly stderr: string;

  constructor(exitCode: number, stderr: string) {
    super(`ffmpeg exited with code ${exitCode}`);
    this.name = "FfmpegError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}