// ---------------------------------------------------------------------------
// validation.ts
//
// Pure functions that validate an uploaded file before any I/O is attempted.
// Keeping validation free of side-effects makes it trivially unit-testable.
// ---------------------------------------------------------------------------

export const ACCEPTED_MIME_TYPES = new Set(["video/mp4"]);

export const ACCEPTED_EXTENSIONS = new Set([".mp4"]);

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Validates the MIME type reported by the multipart form field.
 *
 * NOTE: This checks the Content-Type header provided by the client, not
 * the actual file bytes. Deep content inspection is a Phase 5 concern.
 */
export function validateMimeType(mimeType: string | null): ValidationResult {
  if (!mimeType) {
    return {
      ok: false,
      code: "MISSING_CONTENT_TYPE",
      message: "File upload is missing a Content-Type header.",
    };
  }

  // Strip parameters like "; charset=utf-8"
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";

  if (!ACCEPTED_MIME_TYPES.has(base)) {
    return {
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      message: `Unsupported file type: "${base}". Only video/mp4 is accepted.`,
    };
  }

  return { ok: true };
}

/**
 * Validates the filename extension as a secondary type check.
 */
export function validateExtension(filename: string): ValidationResult {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot !== -1 ? lower.slice(dot) : "";

  if (!ACCEPTED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      code: "UNSUPPORTED_EXTENSION",
      message: `Unsupported file extension: "${ext}". Only .mp4 is accepted.`,
    };
  }

  return { ok: true };
}

/**
 * Validates the file size against the configured maximum.
 *
 * @param sizeBytes  Size of the upload in bytes. Pass -1 if unknown (will pass through).
 * @param maxBytes   Maximum allowed size in bytes.
 */
export function validateFileSize(sizeBytes: number, maxBytes: number): ValidationResult {
  if (sizeBytes === -1) {
    // Size unknown at validation time — enforced during streaming
    return { ok: true };
  }

  if (sizeBytes > maxBytes) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `File size exceeds the maximum allowed size of ${maxMb} MB.`,
    };
  }

  return { ok: true };
}

/**
 * Validates that a filename is present and non-empty.
 */
export function validateFilename(filename: string | null | undefined): ValidationResult {
  if (!filename || filename.trim().length === 0) {
    return {
      ok: false,
      code: "MISSING_FILENAME",
      message: "Upload is missing a filename.",
    };
  }

  // Reject path traversal attempts
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return {
      ok: false,
      code: "INVALID_FILENAME",
      message: "Filename contains invalid characters.",
    };
  }

  return { ok: true };
}