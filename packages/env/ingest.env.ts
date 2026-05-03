import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedEnv } from "./shared.env";
import { authEnv } from "./auth.env";

const DEFAULT_MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export const ingestEnv = () => createEnv({
    extends: [sharedEnv(), authEnv()],
    server: {
        // -----------------------------------------------------------------------------
        // ingest service
        // -----------------------------------------------------------------------------
        INGEST_PORT: z.coerce.number().default(3045),
        INGEST_MAX_UPLOAD_SIZE: z.coerce.number().default(
            DEFAULT_MAX_UPLOAD_SIZE_BYTES,
        ),
    },
    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
});
