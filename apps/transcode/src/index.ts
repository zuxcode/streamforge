// ---------------------------------------------------------------------------
// apps/transcode/src/index.ts
// ---------------------------------------------------------------------------

import { mkdir } from "node:fs/promises";

import { transcodeEnv } from "@streamforge/env";
import { createLogger } from "@streamforge/logger";

import {
  closeTranscodeWorker,
  createTranscodeWorker,
} from "./workers/transcode-worker";

const env = transcodeEnv()


/* =========================================================
 * Logger
 * ======================================================= */
const log = createLogger("transcode:main");

/* =========================================================
 * Bootstrap
 * ======================================================= */
async function bootstrap() {
  // Ensure tmp directory exists before processing jobs
  await mkdir(env.TRANSCODE_TMP_DIR, { recursive: true });

  // Start worker
  createTranscodeWorker();

  log.info(
    {
      concurrency: env.TRANSCODE_CONCURRENCY,
      tmpDir: env.TRANSCODE_TMP_DIR,
      segmentDuration: env.TRANSCODE_SEGMENT_DURATION,
      nodeEnv: env.NODE_ENV,
    },
    "transcode worker started",
  );
}

/* =========================================================
 * Graceful Shutdown
 * ======================================================= */
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ signal }, "shutdown signal received");

  try {
    await closeTranscodeWorker();
    log.info("transcode worker stopped");
    process.exit(0);
  } catch (error) {
    log.error(
      { error: error instanceof Error ? error.message : String(error) },
      "error during shutdown",
    );
    process.exit(1);
  }
}

/* =========================================================
 * Process Signals
 * ======================================================= */
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

/* =========================================================
 * Start Application
 * ======================================================= */
bootstrap().catch((error) => {
  log.error(
    { error: error instanceof Error ? error.message : String(error) },
    "failed to start transcode worker",
  );
  process.exit(1);
});
