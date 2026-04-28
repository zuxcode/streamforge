// ---------------------------------------------------------------------------
// transcode-worker.ts
//
// BullMQ Worker that processes HLS transcode jobs.
// Handles:
//  - Job execution
//  - Progress updates
//  - Error classification (retry vs terminal)
//  - Webhook notifications
// ---------------------------------------------------------------------------

import { type Job, type RedisClient, Worker } from "bullmq";

import {
    createRedisConnection,
    logConnection,
    QUEUE_NAMES,
} from "@streamforge/queue";

import type {
    FireWebhookPayload,
    onProgress,
    TranscodeJob,
} from "@streamforge/types";

import { transcodeEnv as env } from "@streamforge/env";
import { createLogger } from "@streamforge/logger";

import { processHls } from "../processors/hls-processor";
import { classifyError } from "../utils/error-classifier";

const transcodeEnv = env();

/* =========================================================
 * Logger
 * ======================================================= */
const logger = createLogger("transcode:worker");

/* =========================================================
 * Singleton State
 * ======================================================= */
let connection: RedisClient | null = null;
let worker: Worker<TranscodeJob> | null = null;

/* =========================================================
 * Redis Connection
 * ======================================================= */
export function getRedisConnection(redisUrl: string): RedisClient {
    if (!connection) {
        connection = createRedisConnection(redisUrl, false);
    }

    const log = logConnection("Worker");

    connection.on("connecting", log.connecting);
    connection.on("connect", log.connect);
    connection.on("error", log.error);
    connection.on("close", log.close);
    connection.on("reconnecting", log.reconnecting);

    return connection;
}

/* =========================================================
 * Webhook Helper
 * ======================================================= */
async function fireWebhook(url: string, payload: FireWebhookPayload) {
    if (!url) return;

    try {
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        logger.info({ url }, "webhook delivered");
    } catch (err) {
        logger.warn(
            {
                url,
                error: err instanceof Error ? err.message : String(err),
            },
            "webhook failed",
        );
    }
}

/* =========================================================
 * Worker Factory
 * ======================================================= */
export function createTranscodeWorker(): Worker<TranscodeJob> {
    if (!worker) {
        worker = new Worker<TranscodeJob>(
            QUEUE_NAMES.transcode,
            async (job: Job<TranscodeJob>) => {
                const start = Date.now();

                const { jobId, requestId } = job.data;

                logger.info(
                    {
                        jobId,
                        requestId,
                        bullmqJobId: job.id,
                        attempts: job.attemptsMade,
                    },
                    "job started",
                );

                try {
                    /* ---------------- Progress callback ---------------- */
                    const onProgress: onProgress = async (p) => {
                        await job.updateProgress(p);
                    };

                    /* ---------------- Core Processing ---------------- */
                    const result = await processHls(job.data, onProgress);

                    logger.info(
                        {
                            jobId,
                            requestId,
                            durationMs: Date.now() - start,
                            segments: result.segments.length,
                            manifestKey: result.manifestKey,
                            totalDurationSec: result.totalDuration,
                            wallClockMs: Date.now() - start,
                        },
                        "job completed",
                    );

                    return result;
                } catch (err) {
                    const classified = classifyError(err);

                    logger.error(
                        {
                            jobId,
                            requestId,
                            class: classified.class,
                            code: classified.code,
                            message: classified.message,
                            durationMs: Date.now() - start,
                        },
                        "job failed",
                    );

                    /* ---------------- Terminal Failure ---------------- */
                    if (classified.class === "terminal") {
                        const error = new Error(classified.message);
                        error.name = "UnrecoverableError";

                        if (transcodeEnv.TRANSCODE_WEBHOOK_URL) {
                            fireWebhook(
                                transcodeEnv.TRANSCODE_WEBHOOK_URL,
                                {
                                    event: "job.failed",
                                    jobId: job.id ?? jobId,
                                    error: classified.message,
                                    data: null,
                                    status: "failed",
                                },
                            );
                        }

                        throw error;
                    }

                    /* ---------------- Retryable Failure ---------------- */
                    throw err;
                }
            },
            {
                connection: getRedisConnection(transcodeEnv.SF_REDIS_URL),
                concurrency: transcodeEnv.TRANSCODE_CONCURRENCY,

                // Long-running job safety
                lockDuration: 5 * 60 * 1000,
                lockRenewTime: 60 * 1000,
            },
        );
    }

    /* =========================================================
   * Worker Events
   * ======================================================= */

    worker.on("error", (err) => {
        logger.error({ error: String(err) }, "worker error");
    });

    worker.on("stalled", (jobId) => {
        logger.warn({ jobId }, "job stalled");
    });

    worker.on("completed", (job, result) => {
        logger.info(
            {
                jobId: job.id,
                manifest: result.manifestKey,
            },
            "job completed event",
        );
        if (transcodeEnv.TRANSCODE_WEBHOOK_URL) {
            fireWebhook(
                transcodeEnv.TRANSCODE_WEBHOOK_URL,
                {
                    event: "job.complete",
                    jobId: job.id as string,
                    error: null,
                    data: {
                        durationMs: result.totalDuration,
                        filename: result.filename,
                    },
                    status: "completed",
                },
            );
        }
    });

    worker.on("failed", (job, err) => {
        logger.error(
            {
                jobId: job?.id,
                attempts: job?.attemptsMade,
                error: err.message,
            },
            "job failed event",
        );
    });

    return worker;
}

/* =========================================================
 * Shutdown
 * ======================================================= */
export async function closeTranscodeWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
    }

    if (connection) {
        await connection.quit();
        connection = null;
    }
}
