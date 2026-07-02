import { Hono } from "hono";
import { serveStatic } from "hono/bun";

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";

import { createLogger } from "@streamforge/logger";
import { ingestEnv as env } from "@streamforge/env/ingest.env";
import { getTranscodeQueue } from "../queues/queue-client";

/* =========================================================
 * App + Logger
 * ======================================================= */
export const queueRoute = new Hono();
const logger = createLogger("ingest:queue-ui");

const ingestEnv = env()

/* =========================================================
 * Constants
 * ======================================================= */
const BASE_PATH = "/queue/ui";

/* =========================================================
 * Bull Board Setup (encapsulated)
 * ======================================================= */
function setupBullBoard() {
    const serverAdapter = new HonoAdapter(serveStatic);

    const queue = getTranscodeQueue(ingestEnv.SF_REDIS_URL);

    createBullBoard({
        queues: [new BullMQAdapter(queue)],
        serverAdapter,
    });

    serverAdapter.setBasePath(BASE_PATH);

    return serverAdapter;
}

/* =========================================================
 * Route Registration
 * ======================================================= */
const serverAdapter = setupBullBoard();
queueRoute.route(BASE_PATH, serverAdapter.registerPlugin());

/* =========================================================
 * Logging
 * ======================================================= */
logger.info(
    {
        url: `http://localhost:${ingestEnv.INGEST_PORT}${BASE_PATH}`,
        basePath: BASE_PATH,
    },
    "Bull Board UI available",
);

logger.info("Hono + Bull Board initialized");

export { BASE_PATH as queueUIBasePath };
