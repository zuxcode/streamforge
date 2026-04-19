// Parses HTTP Range headers for byte-range requests.
// HLS players (Safari, hls.js) depend on Range support for segment loading.
// Pure function — no I/O, fully unit-testable.

export interface ByteRange {
  start: number;
  end: number;
}

export type RangeParseResult =
  | { ok: true;  range: ByteRange }
  | { ok: false; reason: "absent" | "unsupported" | "invalid" | "unsatisfiable" };

/**
 * Parses a Range header value against a known file size.
 *
 * Supports only the "bytes" unit — the only unit used by HLS players.
 * Returns `reason: "absent"` when the header is not present (serve full file).
 * Returns `reason: "unsatisfiable"` when the range falls outside the file.
 */
export function parseRangeHeader(
  rangeHeader: string | null | undefined,
  totalSize: number,
): RangeParseResult {
  if (!rangeHeader) {
    return { ok: false, reason: "absent" };
  }

  if (!rangeHeader.startsWith("bytes=")) {
    return { ok: false, reason: "unsupported" };
  }

  const spec = rangeHeader.slice("bytes=".length);

  // Multiple ranges (e.g. "bytes=0-50, 100-150") are not supported
  if (spec.includes(",")) {
    return { ok: false, reason: "unsupported" };
  }

  const [startStr, endStr] = spec.split("-");

  // Suffix range: "bytes=-500" means last 500 bytes
  if (startStr === "" && endStr !== undefined && endStr !== "") {
    const suffixLength = parseInt(endStr, 10);
    if (isNaN(suffixLength) || suffixLength <= 0) {
      return { ok: false, reason: "invalid" };
    }
    const start = Math.max(0, totalSize - suffixLength);
    return { ok: true, range: { start, end: totalSize - 1 } };
  }

  const start = parseInt(startStr ?? "", 10);
  const end   = endStr === "" || endStr === undefined
    ? totalSize - 1
    : parseInt(endStr, 10);

  if (isNaN(start) || isNaN(end)) {
    return { ok: false, reason: "invalid" };
  }

  if (start < 0 || end < start) {
    return { ok: false, reason: "invalid" };
  }

  if (start >= totalSize) {
    return { ok: false, reason: "unsatisfiable" };
  }

  // Clamp end to file boundary
  const clampedEnd = Math.min(end, totalSize - 1);

  return { ok: true, range: { start, end: clampedEnd } };
}

/**
 * Builds the Content-Range response header value.
 * e.g. "bytes 0-1023/4096"
 */
export function buildContentRange(range: ByteRange, totalSize: number): string {
  return `bytes ${range.start}-${range.end}/${totalSize}`;
}