import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    // REDIS
    REDIS_HOST: z.string().min(1),
    REDIS_PORT: z.coerce.number(),
    REDIS_PASSWORD: z.string().optional(),

    // BULLMQ
    WORKER_CONCURRENCY: z.coerce.number().default(2),
    QUEUE_NAME: z.string().default("hls-pipeline"),

    // SYSTEM
    PORT: z.coerce.number().default(6060),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
    TMP_DOWNLOAD_DIR: z.string().default("./tmp"),

    // S3 Bucket
    S3_REGION: z.string(),
    S3_ENDPOINT: z.string(),
    S3_BUCKET: z.string(),
    S3_ACCESS_KEY_ID: z.string(),
    S3_SECRET_ACCESS_KEY: z.string(),
  },

  runtimeEnv: process.env,
});
