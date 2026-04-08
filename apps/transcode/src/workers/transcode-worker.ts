// ---------------------------------------------------------------------------
// transcode-worker.ts
//
// BullMQ Worker that consumes jobs from the transcode queue.
// Each job runs processHls() and is marked completed or failed accordingly.
// ---------------------------------------------------------------------------

import { type Job, type RedisClient, Worker } from "bullmq";
import {
    createRedisConnection,
    logConnection,
    QUEUE_NAMES,
} from "@streamforge/queue";
import type { FireWebhookPayload, TranscodeJob } from "@streamforge/types";
import { serveEnv, transcodeEnv } from "@streamforge/env";
import { createLogger } from "@streamforge/logger";
import { processHls } from "../processors/hls-processor";
import { classifyError } from "../utils/error-classifier";

const logger = createLogger("transcode:worker");

let _connection: RedisClient | null = null;
let _worker: Worker<TranscodeJob> | null = null;

export function getRedisConnection(redisUrl: string): RedisClient {
    if (!_connection) {
        _connection = createRedisConnection(redisUrl, false);
    }

    if (_connection) {
        _connection.on("connecting", logConnection("Worker").connecting);
        _connection.on("connect", logConnection("Worker").connect);
        _connection.on("error", logConnection("Worker").error);
        _connection.on("close", logConnection("Worker").close);
        _connection.on("reconnecting", logConnection("Worker").reconnecting);
    }

    return _connection;
}

// ── Webhook helper ────────────────────────────────────────────────────────────

async function fireWebhook(url: string, payload: FireWebhookPayload) {
    if (!url) return;
    try {
        await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        logger.info(`Webhook delivered to ${url}`);
    } catch (err) {
        logger.warn(
            { error: String(err) },
            `Webhook to ${url} failed: ${(err as Error)?.message}`,
        );
    }
}

export function createTranscodeWorker(): Worker<TranscodeJob> {
    if (!_worker) {
        _worker = new Worker<TranscodeJob>(
            QUEUE_NAMES.transcode,
            async (job: Job<TranscodeJob>) => {
                const { jobId, requestId } = job.data;
                const jobStart = Date.now();

                logger.info({
                    jobId,
                    requestId,
                    attemptsMade: job.attemptsMade,
                    bullmqJobId: job.id,
                }, "job picked up");

                try {
                    const output = await processHls(job.data);

                    logger.info({
                        jobId,
                        requestId,
                        manifestKey: output.manifestKey,
                        segmentCount: output.segments.length,
                        totalDurationSec: output.totalDuration,
                        wallClockMs: Date.now() - jobStart,
                    }, "job completed");

                    return output;
                } catch (err) {
                    const classified = classifyError(err);

                    logger.error({
                        jobId,
                        requestId,
                        errorClass: classified.class,
                        errorCode: classified.code,
                        errorMessage: classified.message,
                        wallClockMs: Date.now() - jobStart,
                    }, "job failed");

                    if (classified.class === "terminal") {
                        // Throw an UnrecoverableError to tell BullMQ not to retry
                        // BullMQ checks for this by the error name
                        const terminal = new Error(classified.message);
                        terminal.name = "UnrecoverableError";

                        if (transcodeEnv.TRANSCODE_WEBHOOK_URL) {
                            await fireWebhook(
                                transcodeEnv.TRANSCODE_WEBHOOK_URL,
                                {
                                    event: "job.failed",
                                    jobId: job.id || "NO_JOB_ID",
                                    error: (err as Error)?.message ||
                                        "Job failed",
                                    data: null,
                                },
                            );
                        }
                        throw terminal;
                    }

                    // Retriable — re-throw so BullMQ applies the backoff policy
                    throw err;
                }
            },
            {
                connection: getRedisConnection(serveEnv.SF_REDIS_URL),
                concurrency: transcodeEnv.TRANSCODE_CONCURRENCY,
                // Lock duration must be longer than the maximum expected transcode time
                lockDuration: 5 * 60 * 1000, // 5 minutes
                // Renew lock automatically for long-running jobs
                lockRenewTime: 60 * 1000, // every 60 seconds
            },
        );
    }

    _worker.on("error", (err) => {
        logger.error({ error: String(err) }, "worker error");
    });

    _worker.on("stalled", (jobId) => {
        logger.warn({ bullmqJobId: jobId }, "job stalled");
    });

    _worker.on("completed", (job, result) => {
        logger.info({
            masterPlaylist: result.masterPlaylist,
        }, `Job ${job.id} completed`);
    });

    _worker.on("failed", (job, err) => {
        logger.error(
            { error: String(err) },
            `Job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`,
        );
    });

    return _worker;
}

export async function closeTranscodeWorker(): Promise<void> {
    if (_worker) {
        await _worker.close();
        _worker = null;
    }
    if (_connection) {
        await _connection.quit();
        _connection = null;
    }
}
