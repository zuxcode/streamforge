import { createStorageClient, StorageKeyNotFoundError } from '@streamforge/storage';
import { serveEnv as env } from '@streamforge/env';
import type { Config, ErrorResponse } from '@streamforge/types';
import { getContentType } from '../middleware/content-type';
import { buildContentRange, parseRangeHeader } from '../middleware/range-parser';
import { createLogger } from '@streamforge/logger';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { PayloadSDK } from '@payloadcms/sdk';

const log = createLogger('serve:stream');
export const streamRoute = new Hono();

const serveEnv = env();

const storage = createStorageClient({
  bucket: serveEnv.SF_S3_BUCKET,
  region: serveEnv.SF_S3_REGION,
  accessKeyId: serveEnv.SF_S3_ACCESS_KEY_ID,
  secretAccessKey: serveEnv.SF_S3_SECRET_ACCESS_KEY,
  endpoint: serveEnv.SF_S3_ENDPOINT,
});

function baseHeaders(meta: Bun.S3Stats) {
  return {
    'Content-Type': meta.type ?? 'application/octet-stream',
    'Content-Length': String(meta.size),
    ...(meta.etag ? { ETag: meta.etag } : {}),
    // Allow players (hls.js, Video.js, Safari) to make range requests
    'Accept-Ranges': 'bytes',
    // Broad CORS so HLS players on any origin can fetch segments
    'Access-Control-Allow-Origin': serveEnv.SF_COR_ORIGIN,
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
    'Cache-Control': 'private, no-store',
  };
}

// ---------------------------------------------------------------------------
// Shared: build a PayloadSDK client from the request cookie
// ---------------------------------------------------------------------------
function buildPayloadClient(token: string) {
  return new PayloadSDK<Config>({
    baseURL: serveEnv.SERVE_STREAM_ENDPOINT,
    baseInit: {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Shared: verify lesson exists and user is enrolled; returns the lesson or
// throws a Response directly so the caller can `return await guardLesson(...)`.
// ---------------------------------------------------------------------------
async function guardLesson(c: Context, lessonId: string): Promise<{ streamPath: string }> {
  const token = getCookie(c, 'payload-token');
  const user = c.get('user');
  const payload = buildPayloadClient(token ?? '');

  const lesson = await payload.findByID({
    collection: 'lessons',
    id: lessonId,
    depth: 1,
    select: { video: true, module: true },
  });

  if (!lesson || typeof lesson.module !== 'object' || typeof lesson.video !== 'object') {
    throw c.json<ErrorResponse>(
      { error: { code: 'NOT_FOUND', message: 'Lesson not found.' } },
      404,
    );
  }

  const courseId =
    typeof lesson.module.course !== 'object' ? lesson.module.course : lesson.module.course.id;

  // CHECK IF USER HAS ENROLL FOR COURSE
  const enrollment = await payload.find({
    collection: 'enrollments',
    depth: 1,
    limit: 1,
    where: {
      course: { equals: courseId },
      user: { equals: user.id },
    },
    select: { status: true },
  });

  if (enrollment.totalDocs <= 0) {
    throw c.json<ErrorResponse>(
      { error: { code: 'NOT_FOUND', message: 'Lesson not found.' } },
      404,
    );
  }

  const streamPath = lesson.video.streamPath ?? null;
  if (!streamPath) {
    throw c.json<ErrorResponse>(
      { error: { code: 'NOT_FOUND', message: 'Stream not found.' } },
      404,
    );
  }

  return { streamPath };
}

streamRoute.get('/stream/:lessonId/processed/:directory/master.m3u8', async (c) => {
  const lessonId = c.req.param('lessonId');

  let s3Key: string;
  try {
    const { streamPath } = await guardLesson(c, lessonId);
    s3Key = streamPath;
  } catch (res) {
    return res as Promise<Response>; // guardLesson throws Response objects
  }

  try {
    const { stream, meta } = await storage.getStream(s3Key);
    return new Response(stream, { status: 200, headers: baseHeaders(meta) });
  } catch (err) {
    if (err instanceof StorageKeyNotFoundError) {
      return c.json<ErrorResponse>(
        { error: { code: 'NOT_FOUND', message: 'Stream not found.' } },
        404,
      );
    }
    return c.json<ErrorResponse>(
      {
        error: {
          code: 'STORAGE_ERROR',
          message: 'Failed to retrieve stream manifest.',
        },
      },
      500,
    );
  }
});

streamRoute.get('/stream/:lessonId/processed/:directory/:quality/:filename', async (c) => {
  const lessonId = c.req.param('lessonId');
  const filename = c.req.param('filename');
  const quality = c.req.param('quality');
  const directory = c.req.param('directory');

  const contentType = getContentType(filename);
  if (!contentType) {
    return c.json<ErrorResponse>(
      {
        error: {
          code: 'UNSUPPORTED_FILE_TYPE',
          message: 'File type not supported.',
        },
      },
      400,
    );
  }

  try {
    await guardLesson(c, lessonId);
  } catch (res) {
    return res as Promise<Response>;
  }

  const s3Key = `processed/${directory}/${quality}/${filename}`;
  log.debug({ directory, filename, s3Key }, 'segment request');

  let stat: Bun.S3Stats;
  let stream: ReadableStream;

  try {
    const file = storage.getFile(s3Key);
    stat = await file.stat(); // throws StorageKeyNotFoundError if absent
    stream = file.stream();
  } catch (err) {
    if (err instanceof StorageKeyNotFoundError) {
      log.warn({ s3Key }, 'segment not found');
      return c.json<ErrorResponse>(
        { error: { code: 'NOT_FOUND', message: 'Segment not found.' } },
        404,
      );
    }
    log.error({ s3Key, error: String(err) }, 'segment fetch failed');
    return c.json<ErrorResponse>(
      {
        error: {
          code: 'STORAGE_ERROR',
          message: 'Failed to retrieve segment.',
        },
      },
      500,
    );
  }

  // Range handling
  const totalSize = stat.size;
  const rangeHeader = c.req.header('range');
  const rangeResult = parseRangeHeader(rangeHeader, totalSize);

  if (!rangeResult.ok) {
    if (rangeResult.reason === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders(stat),
          'Content-Range': `bytes */${totalSize}`,
        },
      });
    }
    log.debug({ s3Key, totalSize }, 'serving full segment');
    return new Response(stream, { status: 200, headers: baseHeaders(stat) });
  }

  const { range } = rangeResult;
  const rangeSize = range.end - range.start + 1;

  log.debug(
    {
      s3Key,
      rangeStart: range.start,
      rangeEnd: range.end,
      totalSize,
    },
    'serving partial segment',
  );
  return new Response(stream, {
    status: 206,
    headers: {
      ...baseHeaders(stat),
      'Content-Length': String(rangeSize),
      'Content-Range': buildContentRange(range, totalSize),
    },
  });
});
