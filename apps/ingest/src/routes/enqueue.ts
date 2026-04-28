// ---------------------------------------------------------------------------
// upload.ts — POST /enqueue route handler
// ---------------------------------------------------------------------------

import { Hono } from "hono";
import { v7 as uuidV7 } from "uuid";
import { zValidator } from "@hono/zod-validator";

import { enqueueTranscodeJob, getQueueDepth } from "@streamforge/queue";

import type { ErrorResponse, UploadAcceptedResponse } from "@streamforge/types";

import { ingestEnv } from "@streamforge/env";
import { getTranscodeQueue } from "../queues/queue-client";
import { uploadPayloadSchema } from "../handlers/schema.zod";
import { createLogger } from "@streamforge/logger";
import { createAuthMiddleware } from "@streamforge/auth";

/* =========================================================
 * App + Logger
 * ======================================================= */
export const enqueueRoute = new Hono();
const logger = createLogger("ingest:enqueue-route");

/* =========================================================
 * Constants
 * ======================================================= */
const ROUTE_PATH = "/enqueue";

// ---------------------------------------------------------------------------
// Auth middleware
//
// Created once at startup. The introspection cache is shared across all
// requests for the lifetime of this process.
// ---------------------------------------------------------------------------

const authMiddleware = createAuthMiddleware({
  publicKey: ingestEnv.AUTH_PUBLIC_KEY,
});

enqueueRoute.use(ROUTE_PATH, authMiddleware);

/* =========================================================
 * Route: POST /enqueue
 * ======================================================= */
enqueueRoute.post(
  ROUTE_PATH,
  zValidator("json", uploadPayloadSchema),
  async (c) => {
    const payload = c.req.valid("json");

    const requestId = c.req.header("x-request-id") ?? uuidV7();
    const jobId = uuidV7();
    const startedAt = Date.now();

    const queue = getTranscodeQueue(ingestEnv.SF_REDIS_URL);

    try {
      /* -----------------------------------------------------
       * Extract + Resolve Input
       * --------------------------------------------------- */
      const {
        mediaId,
        generateThumbnail,
        webhookUrl,
        prefix,
        bucketName,
        filename,
      } = payload;

      logger.debug(payload);

      logger.info(
        {
          requestId,
          jobId,
          mediaId,
          filename,
        },
        "enqueue received",
      );

      /* -----------------------------------------------------
       * Enqueue Job
       * --------------------------------------------------- */
      await enqueueTranscodeJob(queue, {
        jobId,
        requestId,
        filename,
        prefix,
        bucketName,
        uploadedAt: new Date().toISOString(),
        generateThumbnail,
        webhookUrl,
      });

      /* -----------------------------------------------------
       * Observability
       * --------------------------------------------------- */
      const queueDepth = await getQueueDepth(queue);

      logger.info(
        {
          requestId,
          jobId,
          queueDepth,
          durationMs: Date.now() - startedAt,
        },
        "job enqueued",
      );

      /* -----------------------------------------------------
       * Response
       * --------------------------------------------------- */
      return c.json<UploadAcceptedResponse>(
        {
          status: "queued",
          jobId,
          message:
            "Transcode job enqueued successfully. Poll GET /jobs/:id for status.",
          data: null,
        },
        200,
      );
    } catch (error) {
      logger.error(
        {
          requestId,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
        "queue enqueue failed",
      );

      return c.json<ErrorResponse>(
        {
          error: {
            code: "QUEUE_ERROR",
            message: "Failed to queue the transcoding job. Please try again.",
          },
        },
        500,
      );
    }
  },
);
