import path from "node:path";

/**
 * Resolves and normalizes a filename from a given video URL or path.
 *
 * Supports:
 * - S3 URLs (e.g. "s3://bucket/path/to/file.mp4")
 * - HTTP/HTTPS URLs (e.g. "https://example.com/path/to/file.mp4")
 * - Plain file paths (e.g. "uploads/videos/file.mp4")
 *
 * The function extracts:
 * - filePath: the full path without protocol/bucket
 * - filename: original filename (with extension)
 * - sanitizedFilename: URL-safe, lowercase version of filename
 * - filenameWithoutExt: filename without extension
 * - extension: file extension (lowercased)
 *
 * @param videoUrl - The input video URL or file path
 * @returns {S3Resolved} Parsed and normalized file metadata
 *
 * @throws Will throw if:
 * - S3 URL is malformed (missing path)
 * - Filename cannot be extracted
 * - Sanitization results in an invalid filename
 */
export function resolveFile(videoUrl: string): S3Resolved {
    let filePath: string;

    // Detect protocol type
    const isS3Protocol = videoUrl.startsWith("s3://");
    const isHttpProtocol = videoUrl.startsWith("https://") ||
        videoUrl.startsWith("http://");

    if (isS3Protocol) {
        /**
         * Example:
         * s3://bucket-name/path/to/video.mp4
         * -> remove "s3://"
         * -> split at first "/"
         * -> extract "path/to/video.mp4"
         */
        const withoutScheme = videoUrl.slice(5);
        const slash = withoutScheme.indexOf("/");

        if (slash === -1) {
            throw new Error(`Invalid S3 URL (missing path): ${videoUrl}`);
        }

        filePath = withoutScheme.slice(slash + 1);
    } else if (isHttpProtocol) {
        /**
         * Example:
         * https://domain.com/path/to/video%20file.mp4
         * -> extract pathname
         * -> remove leading "/"
         * -> decode URL encoding
         */
        const url = new URL(videoUrl);
        filePath = decodeURIComponent(url.pathname.slice(1));
    } else {
        /**
         * Assume already a valid file path
         */
        filePath = videoUrl;
    }

    /**
     * Extract filename from path
     * - split by "/"
     * - remove empty segments (handles trailing slash)
     * - take last segment
     */
    const rawFilename = filePath.split("/").filter(Boolean).pop();

    if (!rawFilename) {
        throw new Error(`Could not extract filename from URL: ${videoUrl}`);
    }

    /**
     * Parse filename into:
     * - extension (e.g. ".mp4")
     * - filenameWithoutExt (e.g. "video")
     */
    const { ext: extension, name: filenameWithoutExt } = path.parse(
        rawFilename,
    );

    /**
     * Sanitize filename:
     * - replace spaces with "-"
     * - remove unsafe characters
     * - convert to lowercase
     */
    const sanitizedFilename = rawFilename
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9.\-_]/g, "")
        .toLowerCase();

    /**
     * Ensure sanitization didn't result in an invalid filename
     */
    if (!sanitizedFilename || sanitizedFilename === extension.toLowerCase()) {
        throw new Error(
            `Filename "${rawFilename}" produced an empty result after sanitisation.`,
        );
    }

    return {
        filePath, // normalized path (no protocol/bucket)
        filename: rawFilename, // original filename
        sanitizedFilename, // safe for storage/URLs
        filenameWithoutExt, // base name without extension
        extension: extension.toLowerCase(), // normalized extension
    };
}

export interface S3Resolved {
    filePath: string;
    filename: string;
    sanitizedFilename: string;
    filenameWithoutExt: string;
    extension?: string;
}
