import { Hono } from 'hono';
import { v7 as uuidV7 } from 'uuid';
import { zValidator } from '@hono/zod-validator';

import { enqueueTranscodeJob, getQueueDepth } from '@streamforge/queue';

import type { ErrorResponse, UploadAcceptedResponse } from '@streamforge/types';

import { ingestEnv as env } from '@streamforge/env';
import { getTranscodeQueue } from '@streamforge/queue/queue-client';
import { uploadPayloadSchema } from '../handlers/schema.zod';
import { createLogger } from '@streamforge/logger';
import { createStorageClient, s3Keys, StorageKeyNotFoundError } from '@streamforge/storage';

export const enqueueRoute = new Hono();
const logger = createLogger('ingest:enqueue-route');

const ingestEnv = env();

const storage = createStorageClient({
  bucket: ingestEnv.SF_S3_BUCKET,
  region: ingestEnv.SF_S3_REGION,
  accessKeyId: ingestEnv.SF_S3_ACCESS_KEY_ID,
  secretAccessKey: ingestEnv.SF_S3_SECRET_ACCESS_KEY,
  endpoint: ingestEnv.SF_S3_ENDPOINT,
});

/* =========================================================
 * Route: POST /enqueue
 * ======================================================= */
enqueueRoute.post('/enqueue', zValidator('json', uploadPayloadSchema), async (c) => {
  const payload = c.req.valid('json');

  const requestId = c.req.header('x-request-id') ?? uuidV7();
  const jobId = uuidV7();
  const startedAt = Date.now();

  const queue = getTranscodeQueue(ingestEnv.SF_REDIS_URL);

  try {
    /* -----------------------------------------------------
     * Extract + Resolve Input
     * --------------------------------------------------- */
    const { mediaId, generateThumbnail, webhookUrl, prefix, filename } = payload;

    logger.info(
      {
        requestId,
        jobId,
        mediaId,
        filename,
      },
      'enqueue received',
    );

    /* -----------------------------------------------------
     * Enqueue Job
     * --------------------------------------------------- */
    await enqueueTranscodeJob(queue, {
      jobId,
      requestId,
      filename,
      prefix,
      mediaId,
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
      'job enqueued',
    );

    /* -----------------------------------------------------
     * Response
     * --------------------------------------------------- */
    return c.json<UploadAcceptedResponse>(
      {
        status: 'queued',
        jobId,
        message: 'Transcode job enqueued successfully. Poll GET /jobs/:id for status.',
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
      'queue enqueue failed',
    );

    return c.json<ErrorResponse>(
      {
        error: {
          code: 'QUEUE_ERROR',
          message: 'Failed to queue the transcoding job. Please try again.',
        },
      },
      500,
    );
  }
});

enqueueRoute.delete('/processed/:id/master.m3u8', async (c) => {
  const id = c.req.param('id');

  if (!id?.trim()) {
    return c.json<ErrorResponse>(
      {
        error: {
          code: 'INVALID_ID',

          message: 'A valid stream ID is required.',
        },
      },
      400,
    );
  }
  const s3Key = s3Keys.segment(id);
  logger.debug({ id, s3Key }, 'directory request');

  try {
    await storage.delete(s3Key);

    logger.info({ id, s3Key }, 'manifest deleted');

    return c.json({
      message: 'Manifest deleted successfully',
    });
  } catch (err) {
    if (err instanceof StorageKeyNotFoundError) {
      logger.warn({ id, s3Key }, 'manifest not found');
      return c.json<ErrorResponse>(
        { error: { code: 'NOT_FOUND', message: 'Stream not found.' } },
        404,
      );
    }
    logger.error(
      {
        id,
        s3Key,
        error: String(err),
      },
      'manifest delete failed',
    );
    return c.json<ErrorResponse>(
      {
        error: {
          code: 'STORAGE_ERROR',
          message: 'Failed to delete stream manifest.',
        },
      },
      500,
    );
  }
});
