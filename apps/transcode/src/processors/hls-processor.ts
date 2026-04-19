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

import pLimit from "p-limit";
import { join, sep } from "node:path";
import { createStorageClient, s3Keys } from "@streamforge/storage";
import { transcodeEnv } from "@streamforge/env";
import type {
    HlsOutput,
    HlsSegment,
    onProgress,
    TranscodeJob,
    UploadResult,
} from "@streamforge/types";
import {
    buildFfmpegArgs,
    probeResolution,
    type Rendition,
    RENDITIONS,
    runFfmpeg,
    segmentIndexFromFilename,
    writeMasterPlaylist,
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
    onProgress?: onProgress,
): Promise<HlsOutput> {
    const { jobId, s3Key, filename, folderName } = job;
    const jobTmpDir = await createJobTmpDir(
        {
            baseTmpDir: transcodeEnv.TRANSCODE_TMP_DIR,
            jobId,
            filename: folderName,
        },
    );

    try {
        // -----------------------------------------------------------------------
        // 1. Download raw video from S3
        // -----------------------------------------------------------------------
        const localInputPath = inputVideoPath(jobTmpDir, filename);

        logger.info(
            { jobId, s3Key, localInputPath },
            "downloading input from s3",
        );

        // await storage.download(s3Key, { destPath: localInputPath });

        logger.info({ jobId }, "download complete");

        const processedDir = jobTmpDir; // join(jobTmpDir, PROCESSED_BASE_DIR);

        // -----------------------------------------------------------------------
        // 2. Invoke ffmpeg
        // -----------------------------------------------------------------------
        logger.info({
            jobId,
            segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
        }, "transcoding started");

        const transcodeStart = Date.now();
        const manifestPath =
            "/Users/chithedev/Desktop/lab/zuxlab/streamforge/apps/transcode/tmp/streamforge/019d9ff2-7228-7067-ad6f-38c5ea041b3f/Introduction-to-forex-lesson-1/master.m3u8";
        //  await invokeFfmpeg(
        //     localInputPath,
        //     processedDir,
        //     onProgress,
        // );
        const transcodeDurationMs = Date.now() - transcodeStart;

        logger.info({ jobId, transcodeDurationMs }, "transcoding complete");

        // -----------------------------------------------------------------------
        // 3. Collect output files
        // -----------------------------------------------------------------------
        const segmentFilenames = await listSegmentFiles(jobTmpDir);

        console.log(segmentFilenames);

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
        const run = pLimit(transcodeEnv.TRANSCODE_CONCURRENCY);

        const failed: UploadResult["failed"] = [];
        let done = 0;

        await Promise.allSettled(
            segmentFilenames.map((rel, index) =>
                run(async () => {
                    // Glob already returns forward-slash relative paths; normalise just in case
                    const normalised = rel.split(sep).join("/");

                    const index = segmentIndexFromFilename(normalised) ??
                        segments.length;

                    const destKey = s3Keys.segment(
                        join(folderName, normalised),
                    );

                    const localPath = join(jobTmpDir, normalised);

                    try {
                        await storage.uploadFile(
                            destKey,
                            localPath,
                            "video/MP2T",
                        );
                        segments.push({
                            s3Key: destKey,
                            index,
                            // Segment duration from config — actual duration varies for the last segment
                            duration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
                        });
                    } catch (error) {
                        logger.error(
                            error,
                            `Failed to upload ${localPath}`,
                            "uploadDirectory",
                        );
                        failed.push({ localPath, s3Key, error });
                    }

                    done++;
                    if (done % 10 === 0 || done === segmentFilenames.length) {
                        logger.info(
                            `  Upload ${done}/${segmentFilenames.length} (${failed.length} failed)`,
                        );
                    }
                })
            ),
        );

        // -----------------------------------------------------------------------
        // 5. Upload manifest — only after all segments are confirmed
        // -----------------------------------------------------------------------
        const manifestKey = s3Keys.manifest(folderName);
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
        // await cleanupJobTmpDir(transcodeEnv.TRANSCODE_TMP_DIR, jobId);
        logger.debug({ jobId }, "temp files cleaned up");
    }
}

// ---------------------------------------------------------------------------
// ffmpeg invocation
// ---------------------------------------------------------------------------

async function invokeFfmpeg(
    inputPath: string,
    outputDir: string,
    onProgress?: onProgress,
): Promise<string> {
    // ── Determine which renditions to encode ───────────────────────────────────
    const srcRes = await probeResolution(inputPath);
    let active: Rendition[] = [...RENDITIONS];

    if (srcRes) {
        logger.info(`Source resolution: ${srcRes.width}×${srcRes.height}`);
        active = RENDITIONS.filter((r) => r.height <= srcRes.height);

        if (active.length === 0) {
            logger.warn(
                'Source is smaller than the lowest preset — encoding a single "source" rendition.',
            );
            const fallback = RENDITIONS.at(-1);
            if (fallback) {
                active = [
                    {
                        ...fallback,
                        name: "source",
                        width: srcRes.width,
                        height: srcRes.height,
                    },
                ];
            }
        } else {
            logger.info(
                `Encoding ${active.length} rendition(s): ${
                    active
                        .map((r) => r.name)
                        .join(", ")
                }`,
            );
        }
    }

    // ── Encode sequentially ────────────────────────────────────────────────────
    for (let i = 0; i < active.length; i++) {
        const r = active[i];
        logger.info(`[${i + 1}/${active.length}] Encoding ${r.name}…`);

        const t0 = Date.now();
        await runFfmpeg(
            await buildFfmpegArgs({
                inputPath,
                segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
                outputDir,
                rendition: r,
            }),
        );
        logger.info(
            `  ✔ ${r.name} complete in ${
                ((Date.now() - t0) / 1000).toFixed(1)
            }s`,
        );

        onProgress?.({
            detail: r.name,
            stage: i + 1,
            pct: active.length,
        });
    }

    // ── Write master playlist ──────────────────────────────────────────────────
    const masterPlaylistPath = writeMasterPlaylist(outputDir, active);
    logger.info(`Master playlist → ${masterPlaylistPath}`);

    return masterPlaylistPath;
}
