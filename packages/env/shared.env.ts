import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const sharedEnv = () =>
    createEnv({
        server: {
            // -----------------------------------------------------------------------------
            // Shared Redis
            // -----------------------------------------------------------------------------
            SF_REDIS_URL: z.url().default("redis://localhost:6379"),

            // -----------------------------------------------------------------------------
            // Runtime
            // -----------------------------------------------------------------------------
            NODE_ENV: z.enum(["development", "production", "test"]).default(
                "development",
            ),
            LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default(
                "info",
            ),
            SF_COR_ORIGIN: z.string().default("*"),

            /**
             * @deprecated
             */
            SF_VERBOSE: z.coerce.boolean().default(false),
        },

        runtimeEnv: process.env,

        // IMPORTANT: ensure only expected vars are exposed
        skipValidation: false,
    });
