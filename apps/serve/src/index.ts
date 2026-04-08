// ---------------------------------------------------------------------------
// apps/serve/src/index.ts
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { authEnvConfig, serveConfig, sharedConfig } from "@streamforge/config";
import {
  authErrorResponse,
  createAuthMiddleware,
  requireActiveSubscription,
} from "@streamforge/auth";
import type { HealthResponse } from "@streamforge/types";
import { corsMiddleware } from "./middleware/cors.ts";
import { handleManifest, handleSegment } from "./routes/stream.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("serve", sharedConfig.logLevel);

// ---------------------------------------------------------------------------
// Auth middleware
//
// Created once at startup. The introspection cache is shared across all
// requests — HLS players fetch dozens of segments in rapid succession so
// the cache is critical: without it every segment request would hit the
// auth service.
// ---------------------------------------------------------------------------

const authMiddleware = createAuthMiddleware({
  introspectUrl: authEnvConfig.introspectUrl,
  introspectToken: authEnvConfig.introspectToken,
  cacheTtlSeconds: authEnvConfig.cacheTtlSeconds,
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();

// CORS before everything else, including auth
app.use("*", corsMiddleware({ origins: serveConfig.corsOrigins }));

app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  log.info("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - start,
    range: c.req.header("range") ?? undefined,
    contentLength: c.res.headers.get("content-length") ?? undefined,
  });
});

// Health — public, no auth required
app.get("/health", (c) => c.json<HealthResponse>({ status: "ok" }));

// HLS streaming — requires a valid token AND an active/trialing subscription
//
// authMiddleware validates the opaque token via the auth service (cached).
// requireActiveSubscription() checks the subscription claim in the profile.
// inactive / past_due: 403. Missing/invalid token: 401.
app.get(
  "/stream/:id/index.m3u8",
  authMiddleware,
  async (c) => {
    const user = c.get("user");
    try {
      requireActiveSubscription(user);
    } catch (err) {
      return authErrorResponse(c, err);
    }
    return handleManifest(c);
  },
);

app.get(
  "/stream/:id/:filename",
  authMiddleware,
  async (c) => {
    const user = c.get("user");
    try {
      requireActiveSubscription(user);
    } catch (err) {
      return authErrorResponse(c, err);
    }
    return handleSegment(c);
  },
);

app.notFound((c) =>
  c.json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404)
);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({ port: serveConfig.port, fetch: app.fetch });

log.info("serve service started", {
  port: serveConfig.port,
  corsOrigins: serveConfig.corsOrigins,
  segmentCacheTtl: serveConfig.segmentCacheTtl,
  nodeEnv: sharedConfig.nodeEnv,
});

async function shutdown(signal: string): Promise<void> {
  log.info("shutdown signal received", { signal });
  server.stop();
  log.info("serve service stopped");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
