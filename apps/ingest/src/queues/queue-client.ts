// ---------------------------------------------------------------------------
// queue-client.ts
//
// Initialises and exports a single BullMQ Queue instance for the ingest
// service. Keeping this in its own module makes it easy to mock in tests.
// ---------------------------------------------------------------------------

import {
    createRedisConnection,
    createTranscodeQueue,
} from "@streamforge/queue";
import type { TranscodeJob } from "@streamforge/types";
import type { Queue, RedisClient } from "bullmq";

let _queue: Queue<TranscodeJob> | null = null;
let _connection: RedisClient | null = null;

export function getTranscodeQueue(redisUrl: string): Queue<TranscodeJob> {
    if (!_connection) {
        _connection = createRedisConnection(redisUrl);
    }

    if (!_queue) {
        _queue = createTranscodeQueue(_connection);
    }
    return _queue;
}

export async function closeTranscodeQueue(): Promise<void> {
    if (_queue) {
        await _queue.close();
        _queue = null;
    }
    if (_connection) {
        await _connection.quit();
        _connection = null;
    }
}
