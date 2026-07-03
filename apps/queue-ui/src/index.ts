import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { HonoAdapter } from "@bull-board/hono";

import { createLogger } from "@streamforge/logger";
import { queueUiEnv as env } from "@streamforge/env";
import { getTranscodeQueue } from "@streamforge/queue";

/* =========================================================
 * App + Logger
 * ======================================================= */
export const queueRoute = new Hono();
const logger = createLogger("queue-ui:bull-board");
const queueUiEnv = env();

/* =========================================================
 * Constants
 * ======================================================= */
const BASE_PATH = "/queue/ui";

/* =========================================================
 * Bull Board Setup (encapsulated)
 * ======================================================= */
function setupBullBoard() {
  const serverAdapter = new HonoAdapter(serveStatic);
  const queue = getTranscodeQueue(queueUiEnv.SF_REDIS_URL);

  // setBasePath must run BEFORE createBullBoard — createBullBoard registers
  // the adapter's routes/asset references at setup time, so if the base
  // path isn't set first those routes get generated against the wrong
  // (default) path.
  serverAdapter.setBasePath(BASE_PATH);

  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter,
  });

  return serverAdapter;
}

queueRoute.get("/health", (c) =>
    c.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime,
        runtime: "bun",
        framework: "hono",
    }));

/* =========================================================
 * Route Registration
 * ======================================================= */
const serverAdapter = setupBullBoard();
queueRoute.route(BASE_PATH, serverAdapter.registerPlugin());

/* =========================================================
 * Logging
 * ======================================================= */
// Note: this runs at module-import time, before Bun.serve() has bound to a
// port in index.ts — so this only confirms setup completed, not that the
// UI is reachable yet. Avoid claiming a live URL here.
logger.info(
  { basePath: BASE_PATH },
  "Bull Board queue UI route registered",
);
