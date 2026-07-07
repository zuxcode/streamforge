// ---------------------------------------------------------------------------
// hls-processor.ts
//
// Orchestrates the full transcoding pipeline for a single job:
//   1. Download raw video from S3 to a temp directory
//   2. Invoke ffmpeg to produce HLS output
//   3. Upload all segments, then per-rendition manifests, then the master
//      manifest to S3
//   4. Clean up the temp directory
//
// All I/O errors are re-thrown so the caller (the BullMQ worker) can decide
// whether to retry based on classifyError().
// ---------------------------------------------------------------------------

import pLimit from 'p-limit';
import { join, sep } from 'node:path';
import { createStorageClient, s3Keys } from '@streamforge/storage';
import { transcodeEnv as env } from '@streamforge/env';
import type {
  HlsOutput,
  HlsSegment,
  onProgress,
  TranscodeJob,
  UploadResult,
} from '@streamforge/types';
import {
  buildFfmpegArgs,
  probeResolution,
  type Rendition,
  RENDITIONS,
  runFfmpeg,
  segmentIndexFromFilename,
  writeMasterPlaylist,
} from '../utils/hls-args';
import {
  cleanupJobTmpDir,
  createJobTmpDir,
  inputVideoPath,
  listRenditionManifestFiles,
  listSegmentFiles,
} from '../utils/temp-dir';
import { FfmpegError } from '../utils/error-classifier';
import { createLogger } from '@streamforge/logger';
import { getFolderName, sanitizeFile } from '@streamforge/utils';
import { generateThumbnails } from './thumbnail';

const logger = createLogger('transcode:worker:processor');

const transcodeEnv = env();

const storage = createStorageClient({
  bucket: transcodeEnv.SF_S3_BUCKET,
  region: transcodeEnv.SF_S3_REGION,
  accessKeyId: transcodeEnv.SF_S3_ACCESS_KEY_ID,
  secretAccessKey: transcodeEnv.SF_S3_SECRET_ACCESS_KEY,
  endpoint: transcodeEnv.SF_S3_ENDPOINT,
});

/**
 * Runs the full HLS transcoding pipeline for a single job.
 *
 * @throws StorageKeyNotFoundError if the input S3 key doesn't exist
 * @throws FfmpegError if ffmpeg exits non-zero
 * @throws StorageError if an S3 upload fails
 * @throws Error if one or more segment uploads fail (partial-upload guard)
 */
export async function processHls(job: TranscodeJob, onProgress?: onProgress): Promise<HlsOutput> {
  const { jobId, generateThumbnail, prefix, filename, mediaId } = job;

  const sanitizedFile = sanitizeFile(job.filename);
  const folderName = sanitizeFile(getFolderName(sanitizedFile));
  const s3Key = join(prefix, filename);

  const jobTmpDir = await createJobTmpDir({
    baseTmpDir: transcodeEnv.TRANSCODE_TMP_DIR,
    jobId,
    filename: folderName,
  });

  try {
    // -----------------------------------------------------------------------
    // 1. Download raw video from S3
    // -----------------------------------------------------------------------
    const localInputPath = inputVideoPath(jobTmpDir, filename);

    logger.info({ jobId, s3Key, localInputPath }, 'downloading input from s3');

    onProgress?.({
      stage: 1,
      pct: 0,
      detail: 'downloading video',
    });

    await storage.download(s3Key, { destPath: localInputPath });

    logger.info({ jobId }, 'download complete');

    // -----------------------------------------------------------------------
    // 2. Invoke ffmpeg
    // -----------------------------------------------------------------------
    logger.info(
      {
        jobId,
        segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
      },
      'transcoding started',
    );

    const transcodeStart = Date.now();

    onProgress?.({
      stage: 2,
      pct: 25,
      detail: 'transcoding video',
    });
    const manifestPath = await invokeFfmpeg(localInputPath, jobTmpDir, onProgress);
    const transcodeDurationMs = Date.now() - transcodeStart;

    logger.info({ jobId, transcodeDurationMs }, 'transcoding complete');

    // -----------------------------------------------------------------------
    // 3. Collect output files
    // -----------------------------------------------------------------------

    onProgress?.({
      stage: 3,
      pct: 50,
      detail: 'scanning for .ts files',
    });

    const segmentFilenames = await listSegmentFiles(jobTmpDir);

    if (segmentFilenames.length === 0) {
      throw new FfmpegError(-1, 'ffmpeg produced no segment files');
    }

    logger.info({ jobId, segmentCount: segmentFilenames.length }, 'uploading segments');

    // -----------------------------------------------------------------------
    // 4. Upload segments first — manifest is written last
    // -----------------------------------------------------------------------
    const segments: HlsSegment[] = [];
    const run = pLimit(transcodeEnv.TRANSCODE_CONCURRENCY);

    const failed: UploadResult['failed'] = [];
    let done = 0;

    onProgress?.({
      stage: 4,
      pct: 75,
      detail: 'uploading segments',
    });

    await Promise.allSettled(
      segmentFilenames.map((rel) =>
        run(async () => {
          // Glob already returns forward-slash relative paths; normalise just in case
          const normalised = rel.split(sep).join('/');

          const index = segmentIndexFromFilename(normalised) ?? segments.length;

          const destKey = s3Keys.segment(join(folderName, normalised));

          const localPath = join(jobTmpDir, normalised);

          try {
            await storage.uploadFile(destKey, localPath, 'video/MP2T');
            segments.push({
              s3Key: destKey,
              index,
              // Segment duration from config — actual duration varies for the last segment
              duration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
            });
          } catch (error) {
            logger.error(
              {
                jobId,
                localPath,
                destKey,
                context: 'segment-upload',
                error: error instanceof Error ? error.message : String(error),
                cause: error instanceof Error ? error.cause : String(error),
              },
              'failed to upload segment',
            );
            // NOTE: was previously `s3Key` (the outer-scope
            // input-video key) — every failure recorded the
            // same wrong key regardless of which segment
            // failed. This should reference the segment's own
            // destination key.
            failed.push({ localPath, s3Key: destKey, error });
          }

          done++;
          if (done % 10 === 0 || done === segmentFilenames.length) {
            logger.info(
              {
                jobId,
                done,
                total: segmentFilenames.length,
                failedCount: failed.length,
              },
              'segment upload progress',
            );
          }
        }),
      ),
    );

    // A partial upload (some segments succeeded, some didn't) must not
    // be allowed to proceed to a "successful" manifest upload — that
    // would produce a manifest referencing segments that don't exist
    // in S3, causing playback failures mid-stream. Fail the whole job
    // instead so it can be classified and potentially retried.
    if (failed.length > 0) {
      onProgress?.({
        stage: 100,
        pct: 4,
        detail: 'upload failed, waiting for retry...',
      });
      throw new Error(
        `${failed.length}/${segmentFilenames.length} segment upload(s) failed: ` +
          failed.map((f) => f.s3Key).join(', '),
      );
    }

    // -----------------------------------------------------------------------
    // 5. Upload per-rendition manifests, then the master manifest
    //    — only after all segments are confirmed
    // -----------------------------------------------------------------------
    onProgress?.({
      stage: 5,
      pct: 100,
      detail: 'uploading playlists',
    });

    const renditionManifests = await listRenditionManifestFiles(jobTmpDir);

    await Promise.all(
      renditionManifests.map(async ({ relativePath, rendition }) => {
        const localPath = join(jobTmpDir, relativePath);
        // Mirrors the segment key convention but scoped under the
        // rendition folder, with an HLS-manifest content type
        // rather than video/MP2T — these are playlists, not
        // segments, and were previously uploaded (incorrectly)
        // through the same code path as .ts segments.
        const destKey = s3Keys.manifest(join(folderName, rendition));

        await storage.uploadFile(destKey, localPath, 'application/vnd.apple.mpegurl');
      }),
    );

    const manifestKey = s3Keys.manifest(folderName);
    await storage.uploadFile(manifestKey, manifestPath, 'application/vnd.apple.mpegurl');

    // -----------------------------------------------------------------------
    // 6. Thumbnails (optional)
    // -----------------------------------------------------------------------
    let thumbnailKey: string | null = null;
    if (generateThumbnail) {
      logger.info({ jobId }, 'generating thumbnails');
      onProgress?.({
        stage: 1,
        pct: 25,
        detail: 'Generating thumbnails',
      });
      const [thumbnailLocalPaths] = await generateThumbnails({
        inputPath: localInputPath,
        outputDir: jobTmpDir,
        count: 1,
      });

      onProgress?.({
        stage: 2,
        pct: 50,
        detail: 'Extracting thumbnail S3key',
      });

      thumbnailKey = s3Keys.thumbnail(folderName);

      onProgress?.({
        stage: 3,
        pct: 75,
        detail: 'Uploading thumbnails',
      });
      await storage.uploadFile(thumbnailKey, thumbnailLocalPaths, 'image/jpeg');
    }

    logger.info(
      {
        jobId,
        manifestKey,
        segmentCount: segments.length,
      },
      'upload complete',
    );

    return {
      // NOTE: was previously `` `/${thumbnailKey}` `` unconditionally,
      // which produced the literal string "/null" when
      // generateThumbnail was false (thumbnailKey stays null, and
      // template-stringifying null gives "null"). Any consumer
      // doing `if (result.thumbnailKey)` would have seen a truthy
      // garbage value in that case.
      thumbnailKey: thumbnailKey ? `/${thumbnailKey}` : null,
      manifestKey: `/${manifestKey}`,
      mediaId,
      totalDuration: segments.length * transcodeEnv.TRANSCODE_SEGMENT_DURATION,
      filename: folderName,
      segments,
    };
  } finally {
    onProgress?.({
      stage: 4,
      pct: 100,
      detail: 'temp files cleaned up',
    });
    // Always clean up temp files — even on error
    await cleanupJobTmpDir(transcodeEnv.TRANSCODE_TMP_DIR, jobId);
    logger.debug({ jobId }, 'temp files cleaned up');
  }
}

// ---------------------------------------------------------------------------
// ffmpeg invocation
// ---------------------------------------------------------------------------

async function invokeFfmpeg(
  inputPath: string,
  outputDir: string,
  onProgress?: onProgress,
): Promise<string> {
  // ── Determine which renditions to encode ───────────────────────────────────
  const srcRes = await probeResolution(inputPath);
  let active: Rendition[] = [...RENDITIONS];

  onProgress?.({
    stage: 1,
    pct: 25,
    detail: 'Starting Ffmpeg process pipeline',
  });

  if (srcRes) {
    logger.info({ width: srcRes.width, height: srcRes.height }, 'source resolution detected');
    onProgress?.({
      stage: 2,
      pct: 50,
      detail: 'source resolution detected',
    });

    active = RENDITIONS.filter((r) => r.height <= srcRes.height);

    if (active.length === 0) {
      logger.warn(
        'source is smaller than the lowest preset — encoding a single "source" rendition',
      );
      onProgress?.({
        stage: 4,
        pct: 75,
        detail: "source is smaller than the lowest preset — encoding a single 'source' rendition",
      });

      const fallback = RENDITIONS.at(-1);
      if (fallback) {
        active = [
          {
            ...fallback,
            name: 'source',
            width: srcRes.width,
            height: srcRes.height,
          },
        ];
      }
    } else {
      logger.info({ renditions: active.map((r) => r.name) }, 'renditions selected for encoding');
      onProgress?.({
        stage: 4,
        pct: 75,
        detail: 'renditions selected for encoding',
      });
    }
  }

  // ── Encode sequentially ────────────────────────────────────────────────────
  for (let i = 0; i < active.length; i++) {
    const r = active[i];
    onProgress?.({
      stage: 5,
      pct: 80,
      detail: `encoding rendition ${r.name} path ${inputPath} -> ${outputDir}`,
    });
    logger.info({ rendition: r.name, step: i + 1, total: active.length }, 'encoding rendition');

    const t0 = Date.now();
    await runFfmpeg(
      await buildFfmpegArgs({
        inputPath,
        segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
        outputDir,
        rendition: r,
      }),
    );
    logger.info(
      { rendition: r.name, durationSec: (Date.now() - t0) / 1000 },
      'rendition encode complete',
    );

    onProgress?.({
      detail: r.name,
      stage: i + 1,
      // NOTE: was previously `active.length` — a fixed constant
      // (e.g. always 1 with a single active rendition), not an
      // actual percentage. This now reports real progress through
      // the rendition list.
      pct: Math.round(((i + 1) / active.length) * 100),
    });
  }

  // ── Write master playlist ──────────────────────────────────────────────────
  const masterPlaylistPath = writeMasterPlaylist(outputDir, active);
  logger.info({ masterPlaylistPath }, 'master playlist written');

  return masterPlaylistPath;
}
