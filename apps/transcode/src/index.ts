import { mkdir } from 'node:fs/promises';
import { transcodeEnv } from '@streamforge/env';
import { createLogger } from '@streamforge/logger';
import { closeTranscodeWorker, createTranscodeWorker } from './workers/worker-client';

const env = transcodeEnv();
const log = createLogger('transcode:main');

// Match this to your orchestrator's grace period (e.g. Docker/k8s
// terminationGracePeriodSeconds) so we force-exit just before SIGKILL
// would hit us anyway, rather than being killed mid-log.
const SHUTDOWN_TIMEOUT_MS = 30_000;

async function bootstrap() {
  // Ensure tmp directory exists before processing jobs
  await mkdir(env.TRANSCODE_TMP_DIR, { recursive: true });

  createTranscodeWorker();

  log.info(
    {
      concurrency: env.TRANSCODE_CONCURRENCY,
      tmpDir: env.TRANSCODE_TMP_DIR,
      segmentDuration: env.TRANSCODE_SEGMENT_DURATION,
      nodeEnv: env.NODE_ENV,
    },
    'transcode worker started',
  );
}

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ signal }, 'shutdown signal received');

  // Transcode jobs can run long (ffmpeg on large files). If closing the
  // worker (waiting for in-flight jobs) takes longer than the
  // orchestrator's grace period, we'd get SIGKILLed with no clean exit
  // log and a potentially corrupted partial job. Force exit ourselves
  // just ahead of that.
  const forceExitTimer = setTimeout(() => {
    log.error(
      { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS },
      'graceful shutdown timed out, forcing exit',
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    await closeTranscodeWorker();
    clearTimeout(forceExitTimer);
    log.info('transcode worker stopped');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      'error during shutdown',
    );
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Long-lived worker process consuming a queue and spawning ffmpeg
// subprocesses — surface anything that would otherwise crash silently.
process.on('unhandledRejection', (reason) => {
  log.error(
    {
      reason: reason instanceof Error ? reason.message : String(reason),
      cause: reason instanceof Error ? reason.cause : String(reason),
    },
    'unhandled rejection',
  );
});

process.on('uncaughtException', (error) => {
  log.error({ error: error.message }, 'uncaught exception');
  void shutdown('uncaughtException');
});

bootstrap().catch((error) => {
  log.error(
    { error: error instanceof Error ? error.message : String(error) },
    'failed to start transcode worker',
  );
  process.exit(1);
});
