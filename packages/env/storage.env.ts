import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const storageEnv = () => createEnv({
    server: {
        // -----------------------------------------------------------------------------
        // S3 storage
        // -----------------------------------------------------------------------------
        SF_S3_BUCKET: z.string().min(1),
        SF_S3_REGION: z.string().min(1),
        SF_S3_ACCESS_KEY_ID: z.string().min(1),
        SF_S3_SECRET_ACCESS_KEY: z.string().min(1),
        SF_S3_ENDPOINT: z.url().optional(),
        SF_S3_OUT_DIR: z.string().default("hsl").optional(),
    },

    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
});
