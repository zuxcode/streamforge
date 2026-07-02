import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedEnv } from "./shared.env";
import { authEnv } from "./auth.env";

const CACHE_TTL = 60 * 60 * 24;

export const serveEnv = () =>
    createEnv({
        extends: [sharedEnv(), authEnv()],
        server: {
            // -----------------------------------------------------------------------------
            // serve service
            // -----------------------------------------------------------------------------
            SERVE_PORT: z.coerce.number().default(3048),
            SERVE_CACHE_TTL: z.coerce.number().default(CACHE_TTL),
            SERVE_CORS_ORIGINS: z.string().default("*"),
            SERVE_STREAM_ENDPOINT: z.string().default(
                "http://localhost:3021/api",
            ),
        },
        runtimeEnv: process.env,

        // IMPORTANT: ensure only expected vars are exposed
        skipValidation: false,
    });
