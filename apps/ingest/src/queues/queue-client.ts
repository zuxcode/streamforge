// ---------------------------------------------------------------------------
// queue-client.ts
//
// Provides a singleton BullMQ Queue + Redis connection for the ingest service.
// This module ensures:
//  - Only one Redis connection is created
//  - Only one Queue instance is used
//  - Clean shutdown is supported
// ---------------------------------------------------------------------------

import {
    createRedisConnection,
    createTranscodeQueue,
    logConnection,
} from "@streamforge/queue";

import type { TranscodeJob } from "@streamforge/types";
import type { Queue, RedisClient } from "bullmq";

/* =========================================================
 * Internal State (Singletons)
 * ======================================================= */
let connection: RedisClient | null = null;
let queue: Queue<TranscodeJob> | null = null;

/* =========================================================
 * Helpers
 * ======================================================= */
function attachConnectionListeners(conn: RedisClient) {
    const log = logConnection("Queue");

    conn.on("connecting", log.connecting);
    conn.on("connect", log.connect);
    conn.on("error", log.error);
    conn.on("close", log.close);
    conn.on("reconnecting", log.reconnecting);
}

/* =========================================================
 * Public API
 * ======================================================= */

/**
 * Get (or create) the singleton transcode queue.
 */
export function getTranscodeQueue(redisUrl: string): Queue<TranscodeJob> {
    if (!connection) {
        connection = createRedisConnection(redisUrl);
        attachConnectionListeners(connection);
    }

    if (!queue) {
        queue = createTranscodeQueue(connection);
    }

    return queue;
}

/**
 * Gracefully closes the queue and Redis connection.
 */
export async function closeTranscodeQueue(): Promise<void> {
    if (queue) {
        await queue.close();
        queue = null;
    }

    if (connection) {
        await connection.quit();
        connection = null;
    }
}
