// ---------------------------------------------------------------------------
// hls-processor.ts
//
// Orchestrates the full transcoding pipeline for a single job:
//   1. Download raw video from S3 to a temp directory
//   2. Invoke ffmpeg to produce HLS output
//   3. Upload all segments then the manifest to S3
//   4. Clean up the temp directory
//
// All I/O errors are re-thrown so the caller (the BullMQ worker) can decide
// whether to retry based on classifyError().
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { createStorageClient, s3Keys } from "@streamforge/storage";
import { transcodeEnv } from "@streamforge/env";
import type { HlsOutput, HlsSegment, TranscodeJob } from "@streamforge/types";
import {
    buildFfmpegArgs,
    getHlsOutputPaths,
    segmentIndexFromFilename,
} from "../utils/hls-args";
import {
    cleanupJobTmpDir,
    createJobTmpDir,
    inputVideoPath,
    listSegmentFiles,
} from "../utils/temp-dir";
import { FfmpegError } from "../utils/error-classifier";
import { createLogger } from "@streamforge/logger";

const logger = createLogger("transcode:worker:processor");

const storage = createStorageClient({
    bucket: transcodeEnv.SF_S3_BUCKET,
    region: transcodeEnv.SF_S3_REGION,
    accessKeyId: transcodeEnv.SF_S3_ACCESS_KEY_ID,
    secretAccessKey: transcodeEnv.SF_S3_SECRET_ACCESS_KEY,
    endpoint: transcodeEnv.SF_S3_ENDPOINT,
});

/**
 * Runs the full HLS transcoding pipeline for a single job.
 *
 * @throws StorageKeyNotFoundError if the input S3 key doesn't exist
 * @throws FfmpegError if ffmpeg exits non-zero
 * @throws StorageError if an S3 upload fails
 */
export async function processHls(
    job: TranscodeJob,
): Promise<HlsOutput> {
    const { jobId, s3Key } = job;
    const jobTmpDir = await createJobTmpDir(
        transcodeEnv.TRANSCODE_TMP_DIR,
        jobId,
    );

    try {
        // -----------------------------------------------------------------------
        // 1. Download raw video from S3
        // -----------------------------------------------------------------------
        const localInputPath = inputVideoPath(jobTmpDir);

        logger.info(
            { jobId, s3Key, localInputPath },
            "downloading input from s3",
        );

        await storage.download(s3Key, { destPath: localInputPath });

        logger.info({ jobId }, "download complete");

        // -----------------------------------------------------------------------
        // 2. Invoke ffmpeg
        // -----------------------------------------------------------------------
        logger.info({
            jobId,
            segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
        }, "transcoding started");

        const transcodeStart = Date.now();
        await invokeFfmpeg(localInputPath, jobTmpDir);
        const transcodeDurationMs = Date.now() - transcodeStart;

        logger.info({ jobId, transcodeDurationMs }, "transcoding complete");

        // -----------------------------------------------------------------------
        // 3. Collect output files
        // -----------------------------------------------------------------------
        const segmentFilenames = await listSegmentFiles(jobTmpDir);
        const { manifestPath } = getHlsOutputPaths(jobTmpDir);

        if (segmentFilenames.length === 0) {
            throw new FfmpegError(-1, "ffmpeg produced no segment files");
        }

        logger.info(
            { jobId, segmentCount: segmentFilenames.length },
            "uploading segments",
        );

        // -----------------------------------------------------------------------
        // 4. Upload segments first — manifest is written last
        // -----------------------------------------------------------------------
        const segments: HlsSegment[] = [];

        for (const filename of segmentFilenames) {
            const index = segmentIndexFromFilename(filename) ?? segments.length;
            const destKey = s3Keys.segment(jobId, index);
            const localPath = join(jobTmpDir, filename);

            await storage.uploadFile(destKey, localPath, "video/MP2T");

            segments.push({
                s3Key: destKey,
                index,
                // Segment duration from config — actual duration varies for the last segment
                duration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
            });
        }

        // -----------------------------------------------------------------------
        // 5. Upload manifest — only after all segments are confirmed
        // -----------------------------------------------------------------------
        const manifestKey = s3Keys.manifest(jobId);
        await storage.uploadFile(
            manifestKey,
            manifestPath,
            "application/vnd.apple.mpegurl",
        );

        logger.info({
            jobId,
            manifestKey,
            segmentCount: segments.length,
        }, "upload complete");

        return {
            manifestKey,
            segments,
            totalDuration: segments.length *
                transcodeEnv.TRANSCODE_SEGMENT_DURATION,
            rendition: "720p",
        };
    } finally {
        // Always clean up temp files — even on error
        await cleanupJobTmpDir(transcodeEnv.TRANSCODE_TMP_DIR, jobId);
        logger.debug({ jobId }, "temp files cleaned up");
    }
}

// ---------------------------------------------------------------------------
// ffmpeg invocation
// ---------------------------------------------------------------------------

async function invokeFfmpeg(
    inputPath: string,
    outputDir: string,
): Promise<void> {
    const args = buildFfmpegArgs({
        inputPath,
        outputDir,
        segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
        rendition: "720p",
    });

    const proc = Bun.spawn(["ffmpeg", ...args], {
        stdout: "ignore",
        stderr: "pipe",
    });

    // Collect stderr for logging and error classification
    const stderrChunks: Uint8Array[] = [];
    const reader = proc.stderr.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) stderrChunks.push(value);
    }

    const exitCode = await proc.exited;
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    // Always logger exit code and last 10 lines of stderr
    const stderrTail = stderr.split("\n").slice(-10).join("\n");
    logger.debug({ exitCode, stderrTail }, "ffmpeg exited");

    if (exitCode !== 0) {
        throw new FfmpegError(exitCode, stderr);
    }
}
