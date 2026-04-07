import { Hono } from "hono";
import { showRoutes } from "hono/dev";
import { logger as honoLogger } from "hono/logger";
import { trimTrailingSlash } from "hono/trailing-slash";
import { prettyJSON } from "hono/pretty-json";
import { cors } from "hono/cors";

import { createLogger } from "@streamforge/logger";
import { ingestEnv, sharedEnv } from "@streamforge/env";
import { closeTranscodeQueue } from "./queues/queue-client";
import { handleUpload } from "./routes/upload";
// import { queueRoute } from "./lib/queue-ui";

// ====================== App Setup ======================
const app = new Hono();

const logger = createLogger("ingest-api");

// Middleware
app.use(honoLogger());
app.use(trimTrailingSlash());
app.use("*", cors());
app.use("*", prettyJSON());

// app.route("/", queueRoute);

// Show registered routes in console (development only)
if (process.env.NODE_ENV !== "production") {
  showRoutes(app);
}

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
  }, "request");
});

// ====================== Routes ======================
// GET /health
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime,
    runtime: "bun",
    framework: "hono",
  });
});

// Upload — requires a valid token AND admin role
//
// authMiddleware calls the external auth service (with caching) and sets
// c.get("user"). requireAdminRole() then checks the role claim.
// Non-admins: 403. Missing/invalid token: 401.
app.post(
  "/upload",
  handleUpload,
  // authMiddleware,
  // async (c) => {
  //   const user = c.get("user");
  //   try {
  //     requireAdminRole(user);
  //   } catch (err) {
  //     return authErrorResponse(c, err);
  //   }
  //   return handleUpload(c);
  // },
);

// ====================== Global Error Handler ======================
app.onError((err, c) => {
  console.log(err);

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
  c.json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404)
);

// ====================== Start Server ======================

const server = Bun.serve({ port: ingestEnv.INGEST_PORT, fetch: app.fetch });

logger.info({
  service: "streamforge ingest API",
  url: `http://0.0.0.0:${ingestEnv.INGEST_PORT}`,
  routes: [
    "POST /transcode          → Async (BullMQ)",
    "GET /jobs/:id            → Job status",
    "GET /health              → Health check",
  ],
  port: ingestEnv.INGEST_PORT,
  nodeEnv: sharedEnv.NODE_ENV,
  maxUploadSizeBytes: ingestEnv.INGEST_MAX_UPLOAD_SIZE,
}, "ingest service started");

// ====================== Graceful Shutdown ======================
const shutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  await server.stop();

  try {
    logger.debug("Delaying shutdown (background grace period)...");
    // Close resources here (uncomment when you have them)
    await closeTranscodeQueue();

    logger.info("All resources closed. Shutting down...");
    process.exit(0);
  } catch (cleanupError) {
    logger.error(cleanupError, "Error during cleanup");
    process.exit(1);
  }
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app };
