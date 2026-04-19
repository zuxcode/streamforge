import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { sharedEnv } from "./shared.env";
import { storageEnv } from "./storage.env";

const CACHE_TTL = 60 * 60 * 24;

export const serveEnv = () =>
    createEnv({
        extends: [sharedEnv(), storageEnv()],
        server: {
            // -----------------------------------------------------------------------------
            // serve service
            // -----------------------------------------------------------------------------
            SERVE_PORT: z.coerce.number().default(3048),
            SERVE_CACHE_TTL: z.coerce.number().default(CACHE_TTL),
            SERVE_CORS_ORIGINS: z.string().default("*"),
        },
        runtimeEnv: process.env,

        // IMPORTANT: ensure only expected vars are exposed
        skipValidation: false,
    });
