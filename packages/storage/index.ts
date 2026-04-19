// ---------------------------------------------------------------------------
// @streamforge/storage
//
// Typed wrapper around bun:s3. All three services import from here so S3
// key conventions, error handling, and streaming behaviour are consistent.
//
// Design decisions:
//   - upload()     — streams a ReadableStream or writes bytes directly; never
//                    buffers the full body in memory
//   - uploadFile() — delegates to upload() via Bun.file().stream(); no
//                    duplicated streaming logic
//   - download()   — uses Bun.write(destPath, s3File) for a single-syscall
//                    streaming write; no Node.js stream pipeline needed
//   - getStream()  — attempts the stream directly and maps the S3 404 response
//                    to StorageKeyNotFoundError without a redundant exists() call
//   - stat()       — exposes file size so callers (serve) can set Content-Length
//                    and handle Range requests without reaching into bun:s3 directly
//   - All public methods throw StorageError or StorageKeyNotFoundError —
//                    callers use instanceof, never string matching
// ---------------------------------------------------------------------------

import { S3Client, type S3File } from "bun";

import { join } from "node:path";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Base error for all S3 operation failures.
 * Uses the ES2022 Error.cause standard so stack traces chain correctly.
 */
export class StorageError extends Error {
    public readonly key: string;

    constructor(message: string, key: string, cause?: unknown) {
        super(message, { cause });
        this.name = "StorageError";
        this.key = key;
    }
}

/**
 * Thrown when an S3 key does not exist.
 * Callers that need to distinguish "not found" from other failures use
 * `instanceof StorageKeyNotFoundError`.
 */
export class StorageKeyNotFoundError extends StorageError {
    constructor(key: string) {
        super(`S3 key not found: ${key}`, key);
        this.name = "StorageKeyNotFoundError";
    }
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface StorageClientConfig {
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Custom endpoint for local S3-compatible services (e.g. MinIO). */
    endpoint?: string | undefined;
    /**  Use virtual hosted style endpoint. default to false, when true if endpoint is informed it will ignore the bucket */
    virtualHostedStyle?: boolean;
}

// ---------------------------------------------------------------------------
// Key conventions
//
// Centralised here so no service ever builds an S3 key by string
// interpolation. Adding a new file type means adding one entry here.
// ---------------------------------------------------------------------------

export const s3Keys = {
    /**
     * Key for the raw uploaded video.
     * e.g. raw/original.mp4
     */
    rawVideo: (filename: string): string => join("raw", filename),

    /**
     * Key for the HLS manifest.
     * e.g. processed/abc-123/index.m3u8
     */
    manifest: (filename: string): string =>
        // join("hsl", filename, "master.m3u8"),
        join("processed", filename, "master.m3u8"),

    /**
     * Key for a single HLS segment.
     * e.g. processed/abc-123/seg-000.ts
     */
    segment: (filename: string): string => join("processed", filename),

    /**
     * Prefix for all processed output files for a given job.
     * Useful for listing or bulk-deleting a job's output.
     */
    processedPrefix: (filename: string): string => join("processed", filename),
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UploadOptions {
    /** MIME type written as the S3 object's Content-Type metadata. */
    contentType?: string;
}

export interface DownloadOptions {
    /** Absolute local path to write the downloaded bytes into. */
    destPath: string;
}

export interface ObjectStat {
    /** Size of the object in bytes. */
    size: number;
    /** ETag returned by S3, useful for conditional requests. */
    etag: string | null;
}

export interface StorageClient {
    /**
     * Uploads a stream, byte array, or string to the given S3 key.
     * Streams are consumed chunk-by-chunk — the full body is never buffered.
     */
    upload(
        key: string,
        body: ReadableStream | Uint8Array | string,
        options?: UploadOptions,
    ): Promise<void>;

    /**
     * Uploads a local file to S3 by streaming its contents.
     * Delegates to upload() — no duplicated streaming logic.
     */
    uploadFile(
        key: string,
        sourcePath: string,
        contentType?: string,
    ): Promise<void>;

    /**
     * Downloads an S3 object and writes it to a local file path.
     * Uses Bun.write() for a single-syscall streaming write.
     *
     * @throws StorageKeyNotFoundError if the key does not exist.
     */
    download(key: string, options: DownloadOptions): Promise<void>;

    /**
     * Returns a ReadableStream of the S3 object's bytes.
     * Intended for proxying — the stream is never buffered.
     *
     * @throws StorageKeyNotFoundError if the key does not exist.
     */
    getStream(key: string): Promise<ReadableStream>;

    /**
     * Returns metadata (size, etag) for an S3 object without downloading it.
     *
     * @throws StorageKeyNotFoundError if the key does not exist.
     */
    stat(key: string): Promise<ObjectStat>;

    /**
     * Returns true if the key exists in S3, false if it does not.
     * Never throws StorageKeyNotFoundError — existence is the question.
     */
    exists(key: string): Promise<boolean>;

    /**
     * Deletes the object at the given key.
     * Resolves without error if the key does not exist (idempotent).
     */
    delete(key: string): Promise<void>;

    /**
     * Exposes the raw bun:s3 S3File handle for advanced use cases.
     * Not part of the core StorageClient interface — use with caution.
     */
    getFile(key: string): S3File;
}

// ---------------------------------------------------------------------------
// S3 error detection helpers
// ---------------------------------------------------------------------------

/**
 * bun:s3 surfaces a not-found condition as an error whose message contains
 * "NoSuchKey" or as an HTTP 404 response. This helper normalises both so
 * callers always get a StorageKeyNotFoundError regardless of bun version.
 */
function isNotFoundError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    return (
        msg.includes("nosuchkey") ||
        msg.includes("not found") ||
        msg.includes("404") ||
        msg.includes("does not exist")
    );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a StorageClient backed by bun:s3.
 *
 * All operations normalise errors into StorageError / StorageKeyNotFoundError
 * so callers have a consistent error surface regardless of what bun:s3
 * throws internally.
 */
export function createStorageClient(
    config: StorageClientConfig,
): StorageClient {
    /**
     * Creates a new bun:s3 S3Client instance using the provided config.
     *
     * Notes:
     * - A fresh client is created per call to avoid shared mutable state and
     *   ensure thread-safety across concurrent operations.
     * - Supports both AWS S3 and S3-compatible providers (e.g. MinIO) via the
     *   optional `endpoint` field.
     * - `virtualHostedStyle` controls whether requests use
     *   `{bucket}.host` (true) or `host/{bucket}` (false).
     */
    function getS3Client(): S3Client {
        return new S3Client({
            bucket: config.bucket,
            region: config.region,
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
            virtualHostedStyle: config.virtualHostedStyle ?? false,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        });
    }

    /**
     * Returns a bun:s3 S3File handle scoped to the given object key.
     *
     * Notes:
     * - This is a lightweight handle — no network request is made until an
     *   operation (e.g. exists(), stream(), writer()) is invoked.
     * - All higher-level operations (upload, download, stat, etc.) rely on
     *   this helper to ensure consistent client configuration.
     * - The key must already follow the centralised S3 key conventions.
     */
    function getFile(key: string): S3File {
        return getS3Client().file(key);
    }

    // -------------------------------------------------------------------------
    // upload
    // -------------------------------------------------------------------------
    async function upload(
        key: string,
        body: ReadableStream | Uint8Array | string,
        options: UploadOptions = {},
    ): Promise<void> {
        try {
            const file = getFile(key);
            const writer = file.writer(
                options.contentType ? { type: options.contentType } : {},
            );

            if (body instanceof ReadableStream) {
                const reader = body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        // value is Uint8Array — write() accepts it directly
                        writer.write(value);
                    }
                } finally {
                    reader.releaseLock();
                }
            } else {
                writer.write(body);
            }

            await writer.end();
        } catch (err) {
            // Never re-wrap a StorageError — it already carries the right context
            if (err instanceof StorageError) throw err;
            throw new StorageError(
                `Failed to upload to S3 key: ${key}`,
                key,
                err,
            );
        }
    }

    // -------------------------------------------------------------------------
    // uploadFile
    // -------------------------------------------------------------------------
    async function uploadFile(
        key: string,
        sourcePath: string,
        contentType?: string,
    ): Promise<void> {
        try {
            const localFile = Bun.file(sourcePath);
            // Delegate to upload() — no duplicated streaming loop
            await upload(key, localFile.stream(), { contentType });
        } catch (err) {
            if (err instanceof StorageError) throw err;
            throw new StorageError(
                `Failed to upload file "${sourcePath}" to S3 key: ${key}`,
                key,
                err,
            );
        }
    }

    // -------------------------------------------------------------------------
    // download
    // -------------------------------------------------------------------------
    async function download(
        key: string,
        options: DownloadOptions,
    ): Promise<void> {
        try {
            const file = getFile(key);

            // exists() is a single HEAD request — cheaper than attempting a GET
            // and parsing the error to determine not-found vs other failure.
            const found = await file.exists();
            if (!found) throw new StorageKeyNotFoundError(key);

            // Bun.write(path, S3File) streams the object directly to disk
            // via a single OS write call — no intermediate buffer, no pipeline.
            await Bun.write(options.destPath, file);
        } catch (err) {
            if (err instanceof StorageError) throw err;
            throw new StorageError(
                `Failed to download S3 key: ${key}`,
                key,
                err,
            );
        }
    }

    // -------------------------------------------------------------------------
    // getStream
    // -------------------------------------------------------------------------
    async function getStream(key: string): Promise<ReadableStream> {
        try {
            const file = getFile(key);

            // Attempt the stream directly. bun:s3 opens the connection lazily so
            // we call exists() first to surface a clean StorageKeyNotFoundError
            // rather than letting a 404 propagate as a mid-stream error that the
            // caller (serve route handler) would have no clean way to handle.
            const found = await file.exists();
            if (!found) throw new StorageKeyNotFoundError(key);

            return file.stream();
        } catch (err) {
            if (err instanceof StorageError) throw err;
            // Map any bun:s3 404 signal that slipped through exists() to the typed error
            if (isNotFoundError(err)) throw new StorageKeyNotFoundError(key);
            throw new StorageError(
                `Failed to open stream for S3 key: ${key}`,
                key,
                err,
            );
        }
    }

    // -------------------------------------------------------------------------
    // stat
    // -------------------------------------------------------------------------
    async function stat(key: string): Promise<ObjectStat> {
        try {
            const file = getFile(key);

            // bun:s3 performs a HEAD request to populate .size and .etag.
            // We must access at least one property to trigger the HEAD.
            const stat = await file.stat();

            return {
                size: stat.size,
                etag: stat.etag ?? null,
            };
        } catch (err) {
            if (err instanceof StorageError) throw err;
            if (isNotFoundError(err)) {
                throw new StorageKeyNotFoundError(key);
            }
            throw new StorageError(`Failed to stat S3 key: ${key}`, key, err);
        }
    }

    // -------------------------------------------------------------------------
    // exists
    // -------------------------------------------------------------------------
    async function exists(key: string): Promise<boolean> {
        try {
            return await getFile(key).exists();
        } catch (err) {
            // A not-found signal from bun:s3 should return false, not throw
            if (isNotFoundError(err)) return false;
            throw new StorageError(
                `Failed to check existence of S3 key: ${key}`,
                key,
                err,
            );
        }
    }

    // -------------------------------------------------------------------------
    // delete
    // -------------------------------------------------------------------------
    async function deleteFn(key: string): Promise<void> {
        try {
            await getFile(key).delete();
        } catch (err) {
            // S3 DELETE is idempotent — a 404 is not an error
            if (isNotFoundError(err)) return;
            throw new StorageError(`Failed to delete S3 key: ${key}`, key, err);
        }
    }

    return {
        upload,
        uploadFile,
        download,
        getStream,
        stat,
        exists,
        delete: deleteFn,
        getFile, // exposed for advanced use cases; not part of the core StorageClient interface
    };
}
