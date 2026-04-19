import {
  createStorageClient,
  s3Keys,
  StorageKeyNotFoundError,
} from "@streamforge/storage";
import { serveEnv } from "@streamforge/env";
import type { ErrorResponse } from "@streamforge/types";
import { getContentType } from "../middleware/content-type";
import {
  buildContentRange,
  parseRangeHeader,
} from "../middleware/range-parser";
import { createLogger } from "@streamforge/logger";
import { Hono } from "hono";
import type { HeadersInit } from "bun";

const log = createLogger("serve:middleware");
export const streamRoute = new Hono();

const storage = createStorageClient({
  bucket: serveEnv.SF_S3_BUCKET,
  region: serveEnv.SF_S3_REGION,
  accessKeyId: serveEnv.SF_S3_ACCESS_KEY_ID,
  secretAccessKey: serveEnv.SF_S3_SECRET_ACCESS_KEY,
  endpoint: serveEnv.SF_S3_ENDPOINT,
});

function baseHeaders(
  meta: { size: number; type?: string; etag?: string },
): HeadersInit {
  return {
    "Content-Type": meta.type ?? "application/octet-stream",
    "Content-Length": String(meta.size),
    ...(meta.etag ? { "ETag": meta.etag } : {}),
    // Allow players (hls.js, Video.js, Safari) to make range requests
    "Accept-Ranges": "bytes",
    // Broad CORS so HLS players on any origin can fetch segments
    "Access-Control-Allow-Origin": serveEnv.SF_COR_ORIGIN,
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, ETag",
  };
}

// ---------------------------------------------------------------------------
// GET /stream/:id/master.m3u8
// ---------------------------------------------------------------------------

streamRoute.get("/:id/master.m3u8", async (c) => {
  const id = c.req.param("id");
  const s3Key = s3Keys.manifest(id);

  log.debug({ id, s3Key }, "manifest request");
  let stream: ReadableStream;

  try {
    stream = await storage.getStream(s3Key);
  } catch (err) {
    if (err instanceof StorageKeyNotFoundError) {
      log.warn({ id, s3Key }, "manifest not found");
      return c.json<ErrorResponse>(
        { error: { code: "NOT_FOUND", message: "Stream not found." } },
        404,
      );
    }
    log.error({ id, s3Key, error: String(err) }, "manifest fetch failed");
    return c.json<ErrorResponse>(
      {
        error: {
          code: "STORAGE_ERROR",
          message: "Failed to retrieve stream manifest.",
        },
      },
      500,
    );
  }

  // Manifests must always be fresh — never serve stale playlists
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
});

// ---------------------------------------------------------------------------
// GET /stream/:id/:filename
// Handles .ts segments and any other processed output files.
// ---------------------------------------------------------------------------
streamRoute.get(
  "/:id/:quality/:filename/*",
  async (c) => {
    const id = c.req.param("id");
    const filename = c.req.param("filename");
    const quality = c.req.param("quality");

    // Validate the filename is a recognised HLS type before touching S3
    const contentType = getContentType(filename);

    console.log(contentType);

    if (!contentType) {
      return c.json<ErrorResponse>(
        {
          error: {
            code: "UNSUPPORTED_FILE_TYPE",
            message: "File type not supported.",
          },
        },
        400,
      );
    }

    // Reconstruct the S3 key from the id and filename
    // e.g. /stream/abc-123/seg-000.ts → processed/abc-123/seg-000.ts
    const s3Key = `processed/${id}/${quality}/${filename}`;

    log.debug({ id, filename, s3Key }, "segment request");

    // -------------------------------------------------------------------------
    // Fetch the S3 object — size is needed upfront for Range header handling
    // -------------------------------------------------------------------------
    let stream: ReadableStream;
    let totalSize: number;

    try {
      const file = storage.getFile(s3Key);
      const exists = await storage.exists(s3Key);

      if (!exists) {
        log.warn({ id, filename, s3Key }, "segment not found");
        return c.json<ErrorResponse>(
          { error: { code: "NOT_FOUND", message: "Segment not found." } },
          404,
        );
      }

      totalSize = file.size;
      stream = file.stream();
    } catch (err) {
      if (err instanceof StorageKeyNotFoundError) {
        log.warn({ id, filename, s3Key }, "segment not found");
        return c.json<ErrorResponse>(
          { error: { code: "NOT_FOUND", message: "Segment not found." } },
          404,
        );
      }
      log.error({
        id,
        filename,
        s3Key,
        error: String(err),
      }, "segment fetch failed");
      return c.json<ErrorResponse>(
        {
          error: {
            code: "STORAGE_ERROR",
            message: "Failed to retrieve segment.",
          },
        },
        500,
      );
    }

    // -------------------------------------------------------------------------
    // Range request handling
    // -------------------------------------------------------------------------
    const rangeHeader = c.req.header("range");
    const rangeResult = parseRangeHeader(rangeHeader, totalSize);

    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": `public, max-age=${serveEnv.SERVE_CACHE_TTL}, immutable`,
    };

    if (!rangeResult.ok) {
      if (rangeResult.reason === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${totalSize}` },
        });
      }

      // No range header or unsupported unit — serve the full file
      log.debug({ id, filename, totalSize }, "serving full segment");
      return new Response(stream, {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(totalSize) },
      });
    }

    // Serve the requested byte range
    const { range } = rangeResult;
    const rangeSize = range.end - range.start + 1;

    log.debug({
      id,
      filename,
      rangeStart: range.start,
      rangeEnd: range.end,
      totalSize,
    }, "serving partial segment");

    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(rangeSize),
        "Content-Range": buildContentRange(range, totalSize),
      },
    });
  },
);
