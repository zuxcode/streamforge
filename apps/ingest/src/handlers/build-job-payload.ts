// ---------------------------------------------------------------------------
// build-job-payload.ts
//
// Constructs a validated TranscodeJob payload from a raw upload.
// Pure function — no I/O, fully unit-testable.
// ---------------------------------------------------------------------------

import type { TranscodeJob } from "@streamforge/types";
import { s3Keys } from "@streamforge/storage";
import { v7 as uuidv7 } from "uuid";

export interface BuildPayloadInput {
    originalFilename: string;
    requestId?: string;
}

export interface BuildPayloadResult {
    payload: TranscodeJob;
    /** The S3 key to upload the raw file to. */
    rawS3Key: string;
}

/**
 * Generates a unique jobId and constructs the TranscodeJob payload.
 *
 * Separating this from the handler keeps the shape of the job testable
 * without spinning up a Hono app or touching S3.
 */
export function buildJobPayload(input: BuildPayloadInput): BuildPayloadResult {
    const jobId = uuidv7();
    const rawS3Key = s3Keys.rawVideo(
        jobId,
        sanitiseFilename(input.originalFilename),
    );

    const payload: TranscodeJob = {
        jobId,
        s3Key: rawS3Key,
        originalFilename: input.originalFilename,
        uploadedAt: new Date().toISOString(),
        ...(input.requestId ? { requestId: input.requestId } : {}),
    };

    return { payload, rawS3Key };
}

/**
 * Strips directory components and replaces whitespace so the filename is
 * safe to embed in an S3 key.
 */
function sanitiseFilename(filename: string): string {
    const base = filename.split(/[\\/]/).pop() ?? "upload.mp4";
    return base.replace(/\s+/g, "-").toLowerCase();
}
