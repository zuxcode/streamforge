// Maps HLS file extensions to their correct MIME types.
// Pure function — no I/O, fully unit-testable.

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts":   "video/MP2T",
};

/**
 * Returns the correct Content-Type for an HLS file based on its extension.
 * Returns null if the extension is not a recognised HLS type.
 */
export function getContentType(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? null;
}

/**
 * Returns true if the filename is a recognised HLS file type.
 */
export function isHlsFile(filename: string): boolean {
  return getContentType(filename) !== null;
}