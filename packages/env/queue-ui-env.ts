import { createEnv } from "@t3-oss/env-core";
import { serveEnv } from "./serve.env";


export const queueUiEnv = () =>
    createEnv({
        extends: [serveEnv()],
        server: {},
        runtimeEnv: process.env,

        // IMPORTANT: ensure only expected vars are exposed
        skipValidation: false,
    });
