import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const sharedEnv = createEnv({
    server: {
        // -----------------------------------------------------------------------------
        // Shared Redis
        // -----------------------------------------------------------------------------
        SF_REDIS_URL: z.url().default("redis://localhost:6379"),

        // -----------------------------------------------------------------------------
        // S3 storage
        // -----------------------------------------------------------------------------
        SF_S3_BUCKET: z.string().min(1),
        SF_S3_REGION: z.string().min(1),
        SF_S3_ACCESS_KEY_ID: z.string().min(1),
        SF_S3_SECRET_ACCESS_KEY: z.string().min(1),
        SF_S3_ENDPOINT: z.url().optional(),

        // -----------------------------------------------------------------------------
        // Runtime
        // -----------------------------------------------------------------------------
        NODE_ENV: z.enum(["development", "production", "test"]).default(
            "development",
        ),
        LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

        SF_VERBOSE: z.coerce.boolean().default(false),
        SF_COR_ORIGIN: z.string().default("*"),
    },

    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
});
