// ---------------------------------------------------------------------------
// upload.ts — POST /upload route handler
// ---------------------------------------------------------------------------

import type { Context } from "hono";
import { v7 as uuidV7 } from "uuid";
import { createStorageClient, StorageError } from "@streamforge/storage";
import { enqueueTranscodeJob, getQueueDepth } from "@streamforge/queue";
import type { ErrorResponse, UploadAcceptedResponse } from "@streamforge/types";
import { ingestEnv, sharedEnv } from "@streamforge/env";
import {
  validateExtension,
  validateFilename,
  validateFileSize,
  validateMimeType,
} from "../handlers/validation";
import { buildJobPayload } from "../handlers/build-job-payload";
import { getTranscodeQueue } from "../queues/queue-client";
import { createLogger } from "@streamforge/logger";

const log = createLogger("ingest-api:upload-handler");

const storage = createStorageClient({
  bucket: sharedEnv.SF_S3_BUCKET,
  region: sharedEnv.SF_S3_REGION,
  accessKeyId: sharedEnv.SF_S3_ACCESS_KEY_ID,
  secretAccessKey: sharedEnv.SF_S3_SECRET_ACCESS_KEY,
  endpoint: sharedEnv.SF_S3_ENDPOINT,
});

export async function handleUpload(c: Context): Promise<Response> {
  const requestId = c.req.header("x-request-id") ?? uuidV7();
  const startedAt = Date.now();

  // -------------------------------------------------------------------------
  // 1. Parse multipart form
  // -------------------------------------------------------------------------
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json<ErrorResponse>(
      {
        error: {
          code: "INVALID_FORM",
          message: "Request body must be multipart/form-data.",
        },
      },
      400,
    );
  }

  const fileField = formData.get("file");
  if (!(fileField instanceof File)) {
    return c.json<ErrorResponse>(
      {
        error: {
          code: "MISSING_FILE",
          message: "Form field 'file' is required.",
        },
      },
      400,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Validate
  // -------------------------------------------------------------------------
  const filenameResult = validateFilename(fileField.name);
  if (!filenameResult.ok) {
    return c.json<ErrorResponse>({
      error: { code: filenameResult.code, message: filenameResult.message },
    }, 400);
  }

  const mimeResult = validateMimeType(fileField.type);
  if (!mimeResult.ok) {
    return c.json<ErrorResponse>({
      error: { code: mimeResult.code, message: mimeResult.message },
    }, 400);
  }

  const extResult = validateExtension(fileField.name);
  if (!extResult.ok) {
    return c.json<ErrorResponse>({
      error: { code: extResult.code, message: extResult.message },
    }, 400);
  }

  const sizeResult = validateFileSize(
    fileField.size,
    ingestEnv.INGEST_MAX_UPLOAD_SIZE,
  );
  if (!sizeResult.ok) {
    return c.json<ErrorResponse>({
      error: { code: sizeResult.code, message: sizeResult.message },
    }, 413);
  }

  log.info({
    requestId,
    filename: fileField.name,
    mimeType: fileField.type,
    sizeBytes: fileField.size,
  }, "upload received");

  // -------------------------------------------------------------------------
  // 3. Build job payload
  // -------------------------------------------------------------------------
  const { payload, rawS3Key } = buildJobPayload({
    originalFilename: fileField.name,
    requestId,
  });

  // -------------------------------------------------------------------------
  // 4. Upload to S3 — must succeed before enqueuing
  // -------------------------------------------------------------------------
  try {
    await storage.upload(rawS3Key, fileField.stream(), {
      contentType: "video/mp4",
    });

    log.info({
      requestId,
      jobId: payload.jobId,
      s3Key: rawS3Key,
    }, "s3 upload complete");
  } catch (err) {
    log.error({
      requestId,
      jobId: payload.jobId,
      s3Key: rawS3Key,
      error: err instanceof StorageError ? err.message : String(err),
    }, "s3 upload failed");

    return c.json<ErrorResponse>(
      {
        error: {
          code: "STORAGE_ERROR",
          message: "Failed to store the uploaded file. Please try again.",
        },
      },
      500,
    );
  }

  // -------------------------------------------------------------------------
  // 5. Enqueue job — only after confirmed S3 write
  // -------------------------------------------------------------------------
  const queue = getTranscodeQueue(sharedEnv.SF_REDIS_URL);

  try {
    await enqueueTranscodeJob(queue, payload);

    const depth = await getQueueDepth(queue);

    log.info({
      requestId,
      jobId: payload.jobId,
      queueDepth: depth,
      durationMs: Date.now() - startedAt,
    }, "job enqueued");
  } catch (err) {
    log.error({
      requestId,
      jobId: payload.jobId,
      error: String(err),
    }, "queue enqueue failed");

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

  // -------------------------------------------------------------------------
  // 6. Respond
  // -------------------------------------------------------------------------
  return c.json<UploadAcceptedResponse>(
    { jobId: payload.jobId, status: "queued" },
    202,
  );
}
