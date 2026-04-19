// ---------------------------------------------------------------------------
// @streamforge/queue
//
// Single source of truth for BullMQ queue names, job type definitions,
// retry/backoff policy, and producer helpers. Both ingest (producer) and
// transcode (worker) import from here so the contract never drifts.
//
// Separation of concerns:
//   - Queue names / job names  → constants, never inline strings
//   - Retry / backoff policy   → JOB_OPTIONS, set as defaultJobOptions on
//                                the Queue so workers never need to override
//   - jobId (deduplication)    → passed per add() call, not as a default,
//                                because it must be unique per payload
//   - Connection config        → createRedisConnection(), one place for TLS,
//                                keepAlive, and BullMQ-required settings
// ---------------------------------------------------------------------------

import type { TranscodeJob } from "@streamforge/types";
import { sharedEnv } from "@streamforge/env";
import { createLogger } from "@streamforge/logger";
import { Queue } from "bullmq";
import IORedis, { type Cluster, type Redis } from "ioredis";

const logger = createLogger("queue");

export const logConnection = (name: string) => {
    return {
        connect: () => logger.info(`✅ ${name} connected to Redis`),
        error: (err: Error) => logger.error(err, `❌ ${name} Redis error:`),
        close: () => logger.warn(`⚠️ ${name} Redis connection closed`),
        reconnecting: () => logger.info(`🔄 ${name} reconnecting to Redis...`),
        connecting: () => logger.info(`🔄 ${name} connecting to Redis...`),
    };
};

// ---------------------------------------------------------------------------
// Queue names
// ---------------------------------------------------------------------------

export const QUEUE_NAMES = {
    transcode: "transcode",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Job names
//
// Namespaced as "queue:action" so BullMQ dashboards remain readable when
// multiple job types coexist on one queue in future.
// ---------------------------------------------------------------------------

export const JOB_NAMES = {
    transcode: "transcode:process",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

// ---------------------------------------------------------------------------
// Retry & backoff policy
//
// Defined once here and applied as defaultJobOptions on the Queue instance.
// Workers must NOT override these at the job level — they re-throw retriable
// errors and BullMQ applies this policy automatically.
//
// Attempts: 3 → delays of 5 s, 10 s, 20 s (exponential, base 5 s).
// Failed jobs are retained indefinitely (count: 0) — never silently discarded.
// ---------------------------------------------------------------------------

export const JOB_OPTIONS = {
    transcode: {
        attempts: 5,
        backoff: {
            type: "exponential" as const,
            delay: 5_000,
        },
        removeOnComplete: {
            // Keep the most recent 500 completed jobs for observability
            count: 500,
        },
        removeOnFail: {
            // 0 means retain all — failed jobs must never be auto-deleted
            count: 10,
        },
    },
} as const;

// ---------------------------------------------------------------------------
// Connection factory
//
// Parses a Redis URL into a BullMQ-compatible ioredis ConnectionOptions.
// All services call this rather than building the object themselves so TLS,
// keepAlive, and the two settings BullMQ requires are always applied.
//
// BullMQ requirements:
//   maxRetriesPerRequest: null  — lets BullMQ handle reconnection itself
//   enableOfflineQueue: false   — prevents commands piling up while offline
// ---------------------------------------------------------------------------

export function createRedisConnection(
    redisUrl: string,
    enableReadyCheck: boolean = true,
): IORedis {
    const url = new URL(redisUrl);

    const connection = new IORedis({
        host: url.hostname,
        port: url.port ? parseInt(url.port, 10) : 6379,
        // Empty strings in URL auth fields mean "not provided"
        username: url.username || undefined,
        password: url.password || undefined,
        // Prevent idle connections being dropped by cloud Redis providers
        keepAlive: 30_000,
        // Required by BullMQ — it manages reconnection state itself
        enableOfflineQueue: false,
        maxRetriesPerRequest: null,

        enableReadyCheck: enableReadyCheck, // Recommended for workers

        // Enable TLS for rediss:// (Redis over TLS, e.g. cloud-managed Redis)
        tls: url.protocol === "rediss:" ? {} : undefined,
    });

    if (sharedEnv.SF_VERBOSE) {
        logger.debug({ redisUrl }, "Created Redis connection");
    }

    return connection;
}

// ---------------------------------------------------------------------------
// Queue factory
//
// Returns a typed BullMQ Queue instance for the transcode queue.
// The ingest service uses this to produce jobs.
// The transcode service creates its own Worker using createRedisConnection()
// directly — it does not need a Queue instance.
// ---------------------------------------------------------------------------

export function createTranscodeQueue(
    connection: Redis | Cluster,
): Queue<TranscodeJob> {
    const queue = new Queue<TranscodeJob>(QUEUE_NAMES.transcode, {
        connection,
        // Apply retry/backoff/retention policy at the Queue level so individual
        // add() calls don't need to repeat it. The jobId is NOT set here —
        // it is unique per payload and passed per add() call in enqueueTranscodeJob.
        defaultJobOptions: JOB_OPTIONS.transcode,
    });

    logger.debug({
        name: QUEUE_NAMES.transcode,
        config: JOB_OPTIONS.transcode,
    }, "Created Bullmq Queue");

    return queue;
}

// ---------------------------------------------------------------------------
// Producer helpers
// ---------------------------------------------------------------------------

export interface EnqueueResult {
    /** The jobId that was enqueued or already existed (deduplicated). */
    jobId: string;

    /** The queue the job was sent to. */
    queueName: QueueName;

    /**
     * True when BullMQ returned the existing job rather than creating a new one.
     * This happens when a job with the same jobId already exists in a
     * non-terminal state (waiting, active, or delayed).
     *
     * The upload handler uses this to distinguish "enqueued" from "already queued"
     * in log output. Both outcomes are safe — the video will be transcoded exactly once.
     */
    deduplicated: boolean;
}

/**
 * Enqueues a single transcode job.
 *
 * Deduplication strategy: the payload's own jobId is used as the BullMQ job
 * ID. If a job with that ID already exists in a non-terminal state, BullMQ
 * silently returns the existing job rather than creating a duplicate.
 * `result.deduplicated` tells the caller which case occurred.
 *
 * @throws if Redis is unreachable or the add() call fails for any reason
 *         other than deduplication (which is not an error).
 */
export async function enqueueTranscodeJob(
    queue: Queue<TranscodeJob>,
    payload: TranscodeJob,
): Promise<EnqueueResult> {
    const job = await queue.add(JOB_NAMES.transcode, payload, {
        // Using the payload's jobId as the BullMQ job ID is what gives us
        // deduplication. BullMQ uses this as a Redis key — if it already exists,
        // add() returns the existing Job object instead of creating a new entry.
        jobId: payload.jobId,
    });

    // BullMQ returns the existing Job when deduplicating. The returned job's
    // id always equals payload.jobId; we detect deduplication by checking
    // whether the job was newly created (its timestamp equals "now") vs
    // pre-existing. The most reliable signal is whether job.processedOn is
    // set — a brand-new job has never been processed.
    // In practice, distinguishing new vs deduplicated requires checking whether
    // the job already existed before the add() call, which BullMQ does not
    // expose directly. We approximate it: if the job's timestamp predates this
    // call by more than 1 second it was already in the queue.
    const deduplicated = job.timestamp !== undefined &&
        Date.now() - job.timestamp > 1_000;

    logger.info({
        payloajobId: job.id,
        filename: payload.filename,
        queueName: QUEUE_NAMES.transcode,
        deduplicated,
    }, "Job enqueued");

    return {
        jobId: payload.jobId,
        queueName: QUEUE_NAMES.transcode,
        deduplicated,
    };
}

/**
 * Returns the total number of jobs currently in-flight or waiting.
 * Includes: waiting + active + delayed.
 *
 * Used by ingest to log queue depth at enqueue time. Never throws —
 * queue depth is advisory information and must not fail an upload.
 * Returns -1 on error so callers can log the sentinel without crashing.
 */
export async function getQueueDepth(
    queue: Queue<TranscodeJob>,
): Promise<number> {
    try {
        const counts = await queue.getJobCounts("waiting", "active", "delayed");
        return (counts.waiting ?? 0) + (counts.active ?? 0) +
            (counts.delayed ?? 0);
    } catch (error) {
        if (sharedEnv.SF_VERBOSE) {
            logger.error({
                error,
            }, "Failed to get queue depth");
        }
        // Swallow — depth is observability-only, never load-bearing
        return -1;
    }
}

/**
 * Gracefully closes a Queue's Redis connection.
 * Call this during service shutdown after draining in-flight HTTP requests.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function closeQueue(
    queue: Queue<TranscodeJob>,
    redisConnection: IORedis,
): Promise<void> {
    await queue.close();
    await redisConnection.quit();
}
