import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedEnv } from "./shared.env";

export const transcodeEnv = createEnv({
    extends: [sharedEnv],
    server: {
        // -----------------------------------------------------------------------------
        // transcode service
        // -----------------------------------------------------------------------------
        TRANSCODE_CONCURRENCY: z.coerce.number().default(2),
        TRANSCODE_TMP_DIR: z.string().default("/tmp/streamforge"),
        TRANSCODE_SEGMENT_DURATION: z.coerce.number().default(6),
    },

    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
});
