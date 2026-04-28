import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const authEnv = createEnv({
    server: {
        AUTH_PUBLIC_KEY: z.string(),
        AUTH_CACHE_TTL_SEC: z.coerce.number().optional(),
    },

    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
});
