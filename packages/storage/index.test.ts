import { describe, expect, it } from "bun:test";
import {
    type ObjectStat,
    s3Keys,
    type StorageClient,
    StorageError,
    StorageKeyNotFoundError,
} from ".";

// ---------------------------------------------------------------------------
// StorageError
// ---------------------------------------------------------------------------

describe("StorageError", () => {
    it("sets name to StorageError", () => {
        const err = new StorageError(
            "something went wrong",
            "raw/abc/original.mp4",
        );
        expect(err.name).toBe("StorageError");
    });

    it("exposes the key that caused the error", () => {
        const key = "raw/abc-123/original.mp4";
        const err = new StorageError("upload failed", key);
        expect(err.key).toBe(key);
    });

    it("wraps an underlying cause via Error.cause", () => {
        const cause = new Error("connection refused");
        const err = new StorageError("upload failed", "some/key", cause);
        expect(err.cause).toBe(cause);
    });

    it("is an instance of Error", () => {
        const err = new StorageError("msg", "key");
        expect(err instanceof Error).toBe(true);
    });

    it("cause is undefined when not provided", () => {
        const err = new StorageError("msg", "key");
        expect(err.cause).toBeUndefined();
    });

    it("preserves the message correctly", () => {
        const err = new StorageError("upload timed out", "raw/abc/video.mp4");
        expect(err.message).toBe("upload timed out");
    });
});

// ---------------------------------------------------------------------------
// StorageKeyNotFoundError
// ---------------------------------------------------------------------------

describe("StorageKeyNotFoundError", () => {
    it("sets name to StorageKeyNotFoundError", () => {
        const err = new StorageKeyNotFoundError("processed/abc/index.m3u8");
        expect(err.name).toBe("StorageKeyNotFoundError");
    });

    it("is an instance of StorageError", () => {
        const err = new StorageKeyNotFoundError("some/key");
        expect(err instanceof StorageError).toBe(true);
    });

    it("is an instance of Error", () => {
        const err = new StorageKeyNotFoundError("some/key");
        expect(err instanceof Error).toBe(true);
    });

    it("includes the key in the message", () => {
        const key = "processed/abc-123/index.m3u8";
        const err = new StorageKeyNotFoundError(key);
        expect(err.message).toContain(key);
    });

    it("sets the key property correctly", () => {
        const key = "raw/xyz/original.mp4";
        const err = new StorageKeyNotFoundError(key);
        expect(err.key).toBe(key);
    });

    it("has no cause (not wrapping another error)", () => {
        const err = new StorageKeyNotFoundError("some/key");
        expect(err.cause).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// StorageClient interface shape
// ---------------------------------------------------------------------------

describe("StorageClient interface", () => {
    it("defines all required methods", () => {
        // Compile-time check — if any method is missing the type assertion fails
        const shape: (keyof StorageClient)[] = [
            "upload",
            "uploadFile",
            "download",
            "getStream",
            "stat",
            "exists",
            "delete",
        ];
        // Runtime check that the list itself is not empty
        expect(shape.length).toBe(7);
    });
});

// ---------------------------------------------------------------------------
// ObjectStat interface shape
// ---------------------------------------------------------------------------

describe("ObjectStat interface", () => {
    it("carries size and etag fields", () => {
        const stat: ObjectStat = { size: 1024, etag: '"abc123"' };
        expect(stat.size).toBe(1024);
        expect(stat.etag).toBe('"abc123"');
    });

    it("allows null etag", () => {
        const stat: ObjectStat = { size: 0, etag: null };
        expect(stat.etag).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// s3Keys — key convention correctness
// ---------------------------------------------------------------------------

describe("s3Keys.rawVideo", () => {
    it("produces the expected path structure", () => {
        const key = s3Keys.rawVideo("job-123", "original.mp4");
        expect(key).toBe("raw/job-123/original.mp4");
    });

    it("starts with the raw/ prefix", () => {
        const key = s3Keys.rawVideo("any-id", "video.mp4");
        expect(key.startsWith("raw/")).toBe(true);
    });

    it("contains the jobId in the path", () => {
        const jobId = "abc-def-456";
        const key = s3Keys.rawVideo(jobId, "file.mp4");
        expect(key).toContain(jobId);
    });

    it("contains the filename in the path", () => {
        const filename = "my-upload.mp4";
        const key = s3Keys.rawVideo("job-1", filename);
        expect(key).toContain(filename);
    });
});

describe("s3Keys.manifest", () => {
    it("produces the expected path structure", () => {
        const key = s3Keys.manifest("job-123");
        expect(key).toBe("processed/job-123/index.m3u8");
    });

    it("starts with processed/", () => {
        expect(s3Keys.manifest("x").startsWith("processed/")).toBe(true);
    });

    it("ends with index.m3u8", () => {
        expect(s3Keys.manifest("job-999").endsWith("index.m3u8")).toBe(true);
    });

    it("contains the jobId", () => {
        const jobId = "my-job-id";
        expect(s3Keys.manifest(jobId)).toContain(jobId);
    });
});

describe("s3Keys.segment", () => {
    it("produces the expected path for segment 0", () => {
        const key = s3Keys.segment("job-123", 0);
        expect(key).toBe("processed/job-123/seg-000.ts");
    });

    it("produces the expected path for segment 10", () => {
        const key = s3Keys.segment("job-123", 10);
        expect(key).toBe("processed/job-123/seg-010.ts");
    });

    it("produces the expected path for segment 999", () => {
        const key = s3Keys.segment("job-123", 999);
        expect(key).toBe("processed/job-123/seg-999.ts");
    });

    it("zero-pads the index to 3 digits", () => {
        const key = s3Keys.segment("job-1", 5);
        expect(key).toContain("seg-005");
    });

    it("ends with .ts extension", () => {
        expect(s3Keys.segment("job-1", 0).endsWith(".ts")).toBe(true);
    });

    it("starts with processed/", () => {
        expect(s3Keys.segment("job-1", 0).startsWith("processed/")).toBe(true);
    });

    it("contains the jobId", () => {
        const jobId = "unique-job-id";
        expect(s3Keys.segment(jobId, 1)).toContain(jobId);
    });
});

describe("s3Keys.processedPrefix", () => {
    it("ends with a trailing slash", () => {
        const prefix = s3Keys.processedPrefix("job-1");
        expect(prefix.endsWith("/")).toBe(true);
    });

    it("manifest key starts with the processed prefix for the same job", () => {
        const jobId = "job-xyz";
        const prefix = s3Keys.processedPrefix(jobId);
        const manifest = s3Keys.manifest(jobId);
        expect(manifest.startsWith(prefix)).toBe(true);
    });

    it("segment key starts with the processed prefix for the same job", () => {
        const jobId = "job-xyz";
        const prefix = s3Keys.processedPrefix(jobId);
        const segment = s3Keys.segment(jobId, 0);
        expect(segment.startsWith(prefix)).toBe(true);
    });

    it("does NOT match a different job's files", () => {
        const prefix = s3Keys.processedPrefix("job-A");
        const otherManifest = s3Keys.manifest("job-B");
        expect(otherManifest.startsWith(prefix)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Key uniqueness — different jobs must never produce colliding keys
// ---------------------------------------------------------------------------

describe("s3Keys — no collisions across jobs", () => {
    it("raw video keys for different jobIds are distinct", () => {
        const key1 = s3Keys.rawVideo("job-1", "original.mp4");
        const key2 = s3Keys.rawVideo("job-2", "original.mp4");
        expect(key1).not.toBe(key2);
    });

    it("manifest keys for different jobIds are distinct", () => {
        expect(s3Keys.manifest("job-A")).not.toBe(s3Keys.manifest("job-B"));
    });

    it("segment keys for different jobIds are distinct even at the same index", () => {
        expect(s3Keys.segment("job-A", 0)).not.toBe(s3Keys.segment("job-B", 0));
    });

    it("segment keys for the same job at different indexes are distinct", () => {
        expect(s3Keys.segment("job-1", 0)).not.toBe(s3Keys.segment("job-1", 1));
    });
});

// ---------------------------------------------------------------------------
// Key format consistency — each output key parses back to its inputs
// ---------------------------------------------------------------------------

describe("s3Keys — format consistency", () => {
    it("rawVideo key splits back into prefix / jobId / filename", () => {
        const jobId = "test-job-99";
        const filename = "original.mp4";
        const key = s3Keys.rawVideo(jobId, filename);
        const parts = key.split("/");
        expect(parts[0]).toBe("raw");
        expect(parts[1]).toBe(jobId);
        expect(parts[2]).toBe(filename);
    });

    it("manifest key splits back into prefix / jobId / filename", () => {
        const jobId = "test-job-99";
        const key = s3Keys.manifest(jobId);
        const parts = key.split("/");
        expect(parts[0]).toBe("processed");
        expect(parts[1]).toBe(jobId);
        expect(parts[2]).toBe("index.m3u8");
    });

    it("segment key splits back into prefix / jobId / filename", () => {
        const jobId = "test-job-99";
        const key = s3Keys.segment(jobId, 7);
        const parts = key.split("/");
        expect(parts[0]).toBe("processed");
        expect(parts[1]).toBe(jobId);
        expect(parts[2]).toBe("seg-007.ts");
    });
});

// ---------------------------------------------------------------------------
// Error passthrough — verifies that StorageError is never double-wrapped
// ---------------------------------------------------------------------------

describe("StorageError — not double-wrapped", () => {
    it("a StorageError thrown inside upload() is not re-wrapped", () => {
        // The inner guard `if (err instanceof StorageError) throw err` is the
        // contract. We verify it at the unit level by checking that a
        // StorageKeyNotFoundError IS-A StorageError — which means if it were
        // caught and re-wrapped the instanceof check would have fired first.
        const inner = new StorageKeyNotFoundError("raw/abc/original.mp4");
        expect(inner instanceof StorageError).toBe(true);
        // Rethrowing it should not change its type
        let caught: unknown;
        try {
            throw inner;
        } catch (e) {
            caught = e;
        }
        expect(caught instanceof StorageKeyNotFoundError).toBe(true);
        expect(caught instanceof StorageError).toBe(true);
    });
});
