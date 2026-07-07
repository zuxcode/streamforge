import path from 'node:path';

/**
 * Sanitize a filename for safe use in S3 keys and local filesystem paths:
 * - replace whitespace runs with "-"
 * - strip any character outside [a-zA-Z0-9.\-_]
 * - lowercase the result
 *
 * @throws Error if the input sanitizes to an empty, dot-only, or
 *   leading-dot value. Without this guard, filenames made up mostly or
 *   entirely of characters outside the allowed set (e.g. non-Latin
 *   scripts, emoji, punctuation-only names) could collapse to "" or ".",
 *   which risks path collisions between unrelated jobs when used to
 *   build S3 keys or temp directory paths downstream.
 */
export const sanitizeFile = (file: string): string => {
  const sanitized = file
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9.\-_]/g, '')
    .toLowerCase();

  if (!sanitized || sanitized === '.' || sanitized.startsWith('.')) {
    throw new Error(`Filename sanitizes to an unusable value: "${file}" -> "${sanitized}"`);
  }

  return sanitized;
};

/**
 * Returns the filename without its extension, for use as a per-job
 * folder name, e.g. "video.mp4" -> "video".
 *
 * Note: only the extension-stripped name is returned — the extension
 * itself is discarded. Call `path.parse` directly if you need both.
 */
export const getFolderName = (filename: string): string => path.parse(filename).name;
