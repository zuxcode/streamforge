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

/* =========================================================
 * Progress bands
 * ======================================================= */

/** Fixed weighted pct range + stage id for each top-level phase. */
const PROGRESS_BANDS = {
  download: { stage: 1, from: 0, to: 10 },
  transcode: { stage: 2, from: 10, to: 55 },
  scan: { stage: 3, from: 55, to: 60 },
  uploadSegments: { stage: 4, from: 60, to: 80 },
  uploadManifests: { stage: 5, from: 80, to: 85 },
  thumbnails: { stage: 6, from: 85, to: 95 },
  cleanup: { stage: 7, from: 95, to: 100 },
} as const;

/**
 * Reports progress within a fixed band, given a 0-1 fraction of that
 * band's own work. `fraction` is clamped to [0, 1] so a caller passing a
 * slightly-off value can't push `pct` outside the band (and therefore
 * can't make progress appear to move backward relative to other bands).
 */
function reportBandProgress(
  onProgress: onProgress | undefined,
  band: { stage: number; from: number; to: number },
  fraction: number,
  detail: string,
): void {
  const clamped = Math.min(1, Math.max(0, fraction));
  const pct = Math.round(band.from + clamped * (band.to - band.from));
  onProgress?.({ stage: band.stage, pct, detail });
}

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

    reportBandProgress(onProgress, PROGRESS_BANDS.download, 0, 'downloading video');

    await storage.download(s3Key, { destPath: localInputPath });

    reportBandProgress(onProgress, PROGRESS_BANDS.download, 1, 'download complete');
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

    const manifestPath = await invokeFfmpeg(localInputPath, jobTmpDir, onProgress);
    const transcodeDurationMs = Date.now() - transcodeStart;

    logger.info({ jobId, transcodeDurationMs }, 'transcoding complete');

    // -----------------------------------------------------------------------
    // 3. Collect output files
    // -----------------------------------------------------------------------
    reportBandProgress(onProgress, PROGRESS_BANDS.scan, 0, 'scanning for .ts files');

    const segmentFilenames = await listSegmentFiles(jobTmpDir);

    if (segmentFilenames.length === 0) {
      throw new FfmpegError(-1, 'ffmpeg produced no segment files');
    }

    reportBandProgress(onProgress, PROGRESS_BANDS.scan, 1, 'segment scan complete');

    logger.info({ jobId, segmentCount: segmentFilenames.length }, 'uploading segments');

    // -----------------------------------------------------------------------
    // 4. Upload segments first — manifest is written last
    // -----------------------------------------------------------------------
    const segments: HlsSegment[] = [];
    const run = pLimit(transcodeEnv.TRANSCODE_CONCURRENCY);

    const failed: UploadResult['failed'] = [];
    let done = 0;

    reportBandProgress(onProgress, PROGRESS_BANDS.uploadSegments, 0, 'uploading segments');

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
                ...(error instanceof Error && error.cause !== undefined
                  ? { cause: error.cause }
                  : {}),
              },
              'failed to upload segment',
            );
            failed.push({ localPath, s3Key: destKey, error });
          }

          done++;
          reportBandProgress(
            onProgress,
            PROGRESS_BANDS.uploadSegments,
            done / segmentFilenames.length,
            `uploading segments (${done}/${segmentFilenames.length})`,
          );

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
    //
    // NOTE: this is a failure exit, not a distinct progress band — pct is
    // intentionally left at wherever the upload loop got to rather than
    // jumping to an arbitrary sentinel value. Retry behavior is entirely
    // up to the caller via classifyError(); this function has no notion
    // of "waiting for retry" itself.
    if (failed.length > 0) {
      throw new Error(
        `${failed.length}/${segmentFilenames.length} segment upload(s) failed: ` +
          failed.map((f) => f.s3Key).join(', '),
      );
    }

    // -----------------------------------------------------------------------
    // 5. Upload per-rendition manifests, then the master manifest
    //    — only after all segments are confirmed
    // -----------------------------------------------------------------------
    reportBandProgress(onProgress, PROGRESS_BANDS.uploadManifests, 0, 'uploading playlists');

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

    reportBandProgress(onProgress, PROGRESS_BANDS.uploadManifests, 1, 'playlists uploaded');

    // -----------------------------------------------------------------------
    // 6. Thumbnails (optional)
    // -----------------------------------------------------------------------
    let thumbnailKey: string | null = null;
    if (generateThumbnail) {
      logger.info({ jobId }, 'generating thumbnails');
      reportBandProgress(onProgress, PROGRESS_BANDS.thumbnails, 0, 'generating thumbnails');

      const [thumbnailLocalPaths] = await generateThumbnails({
        inputPath: localInputPath,
        outputDir: jobTmpDir,
        count: 1,
      });

      if (!thumbnailLocalPaths) {
        throw new Error('thumbnailLocalPaths is missing');
      }

      reportBandProgress(onProgress, PROGRESS_BANDS.thumbnails, 0.5, 'uploading thumbnail');

      thumbnailKey = s3Keys.thumbnail(folderName);
      await storage.uploadFile(thumbnailKey, thumbnailLocalPaths, 'image/jpeg');

      reportBandProgress(onProgress, PROGRESS_BANDS.thumbnails, 1, 'thumbnail uploaded');
    } else {
      // No thumbnail work to do — still advance pct through this band so
      // downstream consumers see continuous progress rather than a gap
      // between manifest upload (85%) and cleanup (95%).
      reportBandProgress(onProgress, PROGRESS_BANDS.thumbnails, 1, 'thumbnails skipped');
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
    reportBandProgress(onProgress, PROGRESS_BANDS.cleanup, 0, 'cleaning up temp files');
    // Always clean up temp files — even on error
    await cleanupJobTmpDir(transcodeEnv.TRANSCODE_TMP_DIR, jobId);
    reportBandProgress(onProgress, PROGRESS_BANDS.cleanup, 1, 'temp files cleaned up');
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
  const band = PROGRESS_BANDS.transcode;

  // ── Determine which renditions to encode ───────────────────────────────────
  const srcRes = await probeResolution(inputPath);
  let active: Rendition[] = [...RENDITIONS];

  // Resolution probing + rendition selection is a small, fixed slice of
  // this band's work — allot it the first 10% of the transcode band and
  // give the actual per-rendition encoding the remaining 90%.
  reportBandProgress(onProgress, band, 0, 'starting ffmpeg pipeline');

  if (srcRes) {
    logger.info({ width: srcRes.width, height: srcRes.height }, 'source resolution detected');

    active = RENDITIONS.filter((r) => r.height <= srcRes.height);

    if (active.length === 0) {
      logger.warn(
        'source is smaller than the lowest preset — encoding a single "source" rendition',
      );

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
    }
  }

  reportBandProgress(onProgress, band, 0.1, 'renditions selected');

  // ── Encode sequentially ────────────────────────────────────────────────────
  for (let i = 0; i < active.length; i++) {
    const r = active[i];
    if (!r) {
      throw new Error('No rendition found');
    }
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

    // Remaining 90% of the band is split proportionally across renditions.
    const encodeFraction = 0.1 + 0.9 * ((i + 1) / active.length);
    reportBandProgress(onProgress, band, encodeFraction, `encoded ${r.name}`);
  }

  // ── Write master playlist ──────────────────────────────────────────────────
  const masterPlaylistPath = writeMasterPlaylist(outputDir, active);
  logger.info({ masterPlaylistPath }, 'master playlist written');

  reportBandProgress(onProgress, band, 1, 'master playlist written');

  return masterPlaylistPath;
}
