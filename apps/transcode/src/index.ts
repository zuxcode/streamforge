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

const log = createLogger("transcode");

// Ensure the base tmp directory exists before the worker starts picking up jobs
await mkdir(transcodeEnv.TRANSCODE_TMP_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
createTranscodeWorker();

log.info({
  concurrency: transcodeEnv.TRANSCODE_CONCURRENCY,
  tmpDir: transcodeEnv.TRANSCODE_TMP_DIR,
  segmentDuration: transcodeEnv.TRANSCODE_SEGMENT_DURATION,
  nodeEnv: transcodeEnv.NODE_ENV,
}, "transcode worker started");

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutdown signal received");
  await closeTranscodeWorker();
  log.info("transcode worker stopped");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
