// ---------------------------------------------------------------------------
// queue-client.ts
//
// Provides a singleton BullMQ Queue + Redis connection for the ingest service.
// This module ensures:
//  - Only one Redis connection is created
//  - Only one Queue instance is used
//  - Clean shutdown is supported
// ---------------------------------------------------------------------------
import { closeQueue, createRedisConnection, createTranscodeQueue, logConnection } from './setup';
import type { TranscodeJob } from '@streamforge/types';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { attachConnectionListeners } from './utils';

/* =========================================================
 * Internal State (Singletons)
 * ======================================================= */
let connection: IORedis | null = null;
let queue: Queue<TranscodeJob> | null = null;
let connectionRedisUrl: string | null = null;

/* =========================================================
 * Public API
 * ======================================================= */

/**
 * Get (or create) the singleton transcode queue.
 *
 * Note: `redisUrl` is only honored on the first call that creates the
 * connection. Subsequent calls return the existing singleton — if a
 * different `redisUrl` is passed on a later call, that mismatch is logged
 * as a warning (since it likely indicates a config bug) but the existing
 * connection is still returned rather than silently switched or thrown.
 */
export function getTranscodeQueue(redisUrl: string): Queue<TranscodeJob> {
  if (!connection) {
    connection = createRedisConnection(redisUrl);
    connectionRedisUrl = redisUrl;
    attachConnectionListeners(connection);
  } else if (redisUrl !== connectionRedisUrl) {
    logConnection('Queue').error(
      new Error(
        `getTranscodeQueue called with a different redisUrl than the existing singleton connection was created with. The existing connection is still in use; the new redisUrl was ignored.`,
      ),
    );
  }
  if (!queue) {
    queue = createTranscodeQueue(connection);
  }
  return queue;
}

/**
 * Gracefully closes the queue and Redis connection.
 *
 * Delegates to closeQueue() for the actual shutdown so there's one source
 * of truth for "safe to call twice" behavior. Uses try/finally so a failed
 * queue.close() (e.g. Redis already unreachable) still resets module state
 * and doesn't leak the connection reference.
 */
export async function closeTranscodeQueue(): Promise<void> {
  if (!queue && !connection) return;

  try {
    if (queue && connection) {
      await closeQueue(queue, connection);
    } else if (connection) {
      // Defensive: queue somehow null but connection isn't.
      if (connection.status !== 'end') {
        await connection.quit();
      }
    }
  } finally {
    queue = null;
    connection = null;
    connectionRedisUrl = null;
  }
}
