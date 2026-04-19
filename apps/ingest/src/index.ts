import { Hono } from "hono";
import { showRoutes } from "hono/dev";
import { logger as honoLogger } from "hono/logger";
import { trimTrailingSlash } from "hono/trailing-slash";
import { prettyJSON } from "hono/pretty-json";
import { cors } from "hono/cors";
import { poweredBy } from "hono/powered-by";
import { secureHeaders } from "hono/secure-headers";
import { csrf } from "hono/csrf";

import { createLogger } from "@streamforge/logger";
import { ingestEnv } from "@streamforge/env";

import { closeTranscodeQueue, getTranscodeQueue } from "./queues/queue-client";

import { enqueueRoute } from "./routes/enqueue";
import { queueRoute } from "./handlers/queue-ui";

/* =========================================================
 * Bootstrap (external services)
 * ======================================================= */
getTranscodeQueue(ingestEnv.SF_REDIS_URL);

/* =========================================================
 * App + Logger
 * ======================================================= */
const app = new Hono();
const logger = createLogger("ingest:main-service");

/* =========================================================
 * CORS Config
 * ======================================================= */
const origin = ingestEnv.SF_COR_ORIGIN === "*"
  ? "*"
  : ingestEnv.SF_COR_ORIGIN.split(",").map((o) => o.trim());

/* =========================================================
 * Middleware
 * ======================================================= */
app.use(honoLogger());
app.use(trimTrailingSlash());
app.use(csrf({ origin }));

app.use(
  "*",
  cors({
    origin,
    allowMethods: ["GET", "POST", "HEAD", "OPTIONS"],
    credentials: ingestEnv.SF_COR_ORIGIN !== "*",
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

app.use("*", prettyJSON());
app.use(poweredBy({ serverName: "StreamForge" }));
app.use(secureHeaders());

// Request logging middleware
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();

  logger.info(
    {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
      contentLength: c.res.headers.get("content-length") ?? undefined,
    },
    "request",
  );
});

/* =========================================================
 * Routes
 * ======================================================= */
app.route("/", queueRoute);
app.route("/", enqueueRoute);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime,
    runtime: "bun",
    framework: "hono",
  }));

/* =========================================================
 * Error Handling
 * ======================================================= */
app.onError((err, c) => {
  logger.error(err, "Unhandled error");

  return c.json(
    {
      success: false,
      error: process.env.NODE_ENV === "production"
        ? "Internal Server Error"
        : err.message,
    },
    500,
  );
});

app.notFound((c) =>
  c.json(
    { error: { code: "NOT_FOUND", message: "Route not found." } },
    404,
  )
);

/* =========================================================
 * Server Startup
 * ======================================================= */
const server = Bun.serve({
  port: ingestEnv.INGEST_PORT,
  fetch: app.fetch,
});

logger.info(
  {
    service: "streamforge ingest API",
    url: `http://0.0.0.0:${ingestEnv.INGEST_PORT}`,
    routes: [
      "POST /enqueue        → Async (BullMQ)",
      "GET /jobs/:id       → Job status",
      "GET /health         → Health check",
    ],
    port: ingestEnv.INGEST_PORT,
    nodeEnv: ingestEnv.NODE_ENV,
    maxUploadSizeBytes: ingestEnv.INGEST_MAX_UPLOAD_SIZE,
  },
  "ingest service started",
);

/* =========================================================
 * Graceful Shutdown
 * ======================================================= */
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  await server.stop();

  try {
    logger.debug("Closing resources...");
    await closeTranscodeQueue();

    logger.info("Shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error(err, "Shutdown error");
    process.exit(1);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/* =========================================================
 * Dev Tools
 * ======================================================= */
if (ingestEnv.NODE_ENV !== "production") {
  showRoutes(app);
}

export { app };
