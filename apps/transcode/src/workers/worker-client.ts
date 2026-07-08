// ---------------------------------------------------------------------------
//
// BullMQ Worker that processes HLS transcode jobs.
// Handles:
//  - Job execution
//  - Progress updates
//  - Error classification (retry vs terminal)
//  - Webhook notifications
// ---------------------------------------------------------------------------

import { type Job, UnrecoverableError, Worker } from 'bullmq';
import type IORedis from 'ioredis';
import { createRedisConnection, logConnection, QUEUE_NAMES } from '@streamforge/queue';

import type { FireWebhookPayload, onProgress, TranscodeJob } from '@streamforge/types';
import { payloadClient } from '@streamforge/payload';

import { transcodeEnv as env } from '@streamforge/env';
import { createLogger } from '@streamforge/logger';
import { attachConnectionListeners } from '@streamforge/queue';
import { processHls } from '../processors/hls-processor';
import { classifyError } from '../utils/error-classifier';

const transcodeEnv = env();

/* =========================================================
 * Logger
 * ======================================================= */
const logger = createLogger('worker');

/* =========================================================
 * Singleton State
 * ======================================================= */
let connection: IORedis | null = null;
let worker: Worker<TranscodeJob> | null = null;
let connectionRedisUrl: string | null = null;

/* =========================================================
 * Redis Connection
 * ======================================================= */
/**
 * Get (or create) the singleton worker Redis connection.
 *
 * Note: `redisUrl` is only honored on the first call that creates the
 * connection. Subsequent calls return the existing singleton — if a
 * different `redisUrl` is passed on a later call, that mismatch is logged
 * as an error (since it likely indicates a config bug) but the existing
 * connection is still returned rather than silently switched or thrown.
 */
export function getRedisConnection(redisUrl: string): IORedis {
  if (!connection) {
    connection = createRedisConnection(redisUrl, false);
    connectionRedisUrl = redisUrl;

    // Attach listeners only on first creation — attaching on every call
    // would stack duplicate listeners on subsequent calls, causing
    // multiplied log lines / webhook fires as the process runs.
    attachConnectionListeners(connection, 'Worker');
  } else if (redisUrl !== connectionRedisUrl) {
    logConnection('Queue').error(
      new Error(
        `
                getTranscodeQueue called with a different redisUrl than the existing singleton connection 
                was created with. The existing connection is still in use; the new redisUrl was ignored.
                `,
      ),
    );
  }

  return connection;
}

/* =========================================================
 * Webhook Helper
 * ======================================================= */
async function fireWebhook(url: string, payload: FireWebhookPayload) {
  if (!url) {
    logger.warn('webhook not configured');
    return;
  }

  const client = payloadClient({
    token: transcodeEnv.SERVER_API_KEY,
    strategy: 'apiKey',
  });

  try {
    const res = await client.fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errror = await res.json();
      logger.warn(
        {
          url,
          status: res.status,
          statusText: res.statusText,
          errror,
        },
        'webhook delivery failed',
      );

      return;
    }

    logger.info(
      {
        url,
        status: res.status,
      },
      'webhook delivered',
    );
  } catch (err) {
    logger.warn(
      {
        url,
        error: err instanceof Error ? err.message : String(err),
        cause: err instanceof Error ? err.cause : String(err),
      },
      'webhook failed',
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
          'job started',
        );

        try {
          /* ---------------- Progress callback ---------------- */
          const onProgress: onProgress = async (p) => {
            await job.updateProgress(p);
          };

          /* ---------------- Core Processing ---------------- */
          const result = await processHls(job.data, onProgress);

          const loggerPayload = {
            jobId,
            requestId,
            durationMs: Date.now() - start,
            segments: result.segments.length,
            manifestKey: result.manifestKey,
            thumbnail: result?.thumbnailKey,
            totalDurationSec: result.totalDuration,
            wallClockMs: Date.now() - start,
          };

          logger.info(loggerPayload, 'job completed');

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
            'job failed',
          );

          /* ---------------- Terminal Failure ---------------- */
          // NOTE: webhook notification for terminal failures is
          // handled centrally in the worker's "failed" event
          // listener below (see the dedupe note there), not here,
          // so there's a single place that decides "job failed for
          // good" and fires exactly one webhook for it.
          if (classified.class === 'terminal') {
            // Throwing BullMQ's actual UnrecoverableError is what
            // stops retries — a plain Error with .name reassigned
            // to the string "UnrecoverableError" does NOT trigger
            // this behavior, since BullMQ checks `instanceof`.
            throw new UnrecoverableError(classified.message);
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

    /* =========================================================
     * Worker Events (attached only on first creation — see note
     * on getRedisConnection above for why this matters)
     * ======================================================= */
    worker.on('error', (err) => {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
          cause: err instanceof Error ? err.cause : String(err),
        },
        'worker error',
      );
    });

    worker.on('stalled', (jobId) => {
      logger.warn({ jobId }, 'job stalled');
    });

    worker.on('completed', (job, result) => {
      logger.info(
        {
          jobId: job.id,
          manifest: result.manifestKey,
        },
        'job completed event',
      );
      if (transcodeEnv.TRANSCODE_WEBHOOK_URL) {
        void fireWebhook(transcodeEnv.TRANSCODE_WEBHOOK_URL, {
          event: 'job.complete',
          jobId: job.id as string,
          error: null,
          cause: null,
          data: {
            durationMs: result.totalDuration,
            filename: result.filename,
            manifestKey: result.manifestKey,
            mediaId: result.mediaId,
            thumbnailKey:
              'thumbnailKey' in result && typeof result.thumbnailKey === 'string'
                ? result.thumbnailKey
                : undefined,
          },
          status: 'completed',
        });
      }
    });

    worker.on('failed', (job, err) => {
      logger.error(
        {
          jobId: job?.id,
          attempts: job?.attemptsMade,
          error: err.message,
          cause: err.cause,
        },
        'job failed event',
      );

      if (!job || !transcodeEnv.TRANSCODE_WEBHOOK_URL) return;

      // BullMQ's "failed" event fires on EVERY failed attempt, not
      // just the final one. We only want to notify once the job has
      // definitively stopped retrying, which happens when either:
      //   (a) the error was classified as terminal (UnrecoverableError
      //       — BullMQ won't retry regardless of attempts remaining), or
      //   (b) the job has exhausted its configured retry attempts.
      const isTerminal = err instanceof UnrecoverableError;
      const maxAttempts = job.opts.attempts ?? 1;
      const attemptsExhausted = job.attemptsMade >= maxAttempts;

      if (isTerminal || attemptsExhausted) {
        void fireWebhook(transcodeEnv.TRANSCODE_WEBHOOK_URL, {
          event: 'job.failed',
          jobId: job.id as string,
          error: err.message,
          cause: err instanceof Error ? (err.cause as string) : String(err),
          data: null,
          status: 'failed',
        });
      }
    });
  }

  return worker;
}

/* =========================================================
 * Shutdown
 * ======================================================= */
export async function closeTranscodeWorker(): Promise<void> {
  if (!worker && !connection) return;

  try {
    if (worker) {
      await worker.close();
    }
  } finally {
    worker = null;
  }

  try {
    if (connection && connection.status !== 'end') {
      await connection.quit();
    }
  } finally {
    connection = null;
  }
}
