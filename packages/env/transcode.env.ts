import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedEnv } from "./shared.env";
import { storageEnv } from "./storage.env";

export const transcodeEnv = () =>
    createEnv({
        extends: [sharedEnv(), storageEnv()],
        server: {
            // -----------------------------------------------------------------------------
            // transcode service
            // -----------------------------------------------------------------------------
            TRANSCODE_CONCURRENCY: z.coerce.number().default(2),
            TRANSCODE_TMP_DIR: z.string().default("./tmp/streamforge"),
            TRANSCODE_SEGMENT_DURATION: z.coerce.number().default(6),
            TRANSCODE_WEBHOOK_URL: z.url().optional(),
            OUTPUT_DIR: z.string().default("processed"),
        },

        runtimeEnv: process.env,

        // IMPORTANT: ensure only expected vars are exposed
        skipValidation: false,
    });
