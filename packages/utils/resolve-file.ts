import path from "node:path";

/**
 * Sanitize filename:
 * - replace spaces with "-"
 * - remove unsafe characters
 * - convert to lowercase
 */
export const sanitizeFile = (file: string) =>
    file.replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9.\-_]/g, "")
        .toLowerCase();

/**
 * Parse filename into:
 * - extension (e.g. ".mp4")
 * - filenameWithoutExt (e.g. "video")
 */
export const getFolderName = (filename: string) => path.parse(filename).name;
