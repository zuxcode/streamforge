// import { createEnv } from "@t3-oss/env-core";
// import { z } from "zod";

// export const env = createEnv({
//     server: {
//         // -----------------------------------------------------------------------------
//         // Shared Redis
//         // -----------------------------------------------------------------------------
//         SF_REDIS_URL: z.url().default("redis://localhost:6379"),

//         // -----------------------------------------------------------------------------
//         // S3 storage
//         // -----------------------------------------------------------------------------
//         SF_S3_BUCKET: z.string().min(1),
//         SF_S3_REGION: z.string().min(1),
//         SF_S3_ACCESS_KEY_ID: z.string().min(1),
//         SF_S3_SECRET_ACCESS_KEY: z.string().min(1),
//         SF_S3_ENDPOINT: z.url().optional(),


        

//         // -----------------------------------------------------------------------------
//         // Runtime
//         // -----------------------------------------------------------------------------
//         NODE_ENV: z.enum(["development", "production", "test"]).default(
//             "development",
//         ),
//         LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

//         // -----------------------------------------------------------------------------
//         // ingest service
//         // -----------------------------------------------------------------------------
//         INGEST_PORT: z.coerce.number().default(3089),
//         // Default: 2147483648 (2 GB)
//         INGEST_MAX_UPLOAD_SIZE: z.coerce.number().default(2147483648),

//         // -----------------------------------------------------------------------------
//         // transcode service
//         // -----------------------------------------------------------------------------
//         TRANSCODE_CONCURRENCY: z.coerce.number().default(2),
//         TRANSCODE_TMP_DIR: z.string().default("/tmp/streamforge"),
//         TRANSCODE_SEGMENT_DURATION: z.coerce.number().default(6),

//         // -----------------------------------------------------------------------------
//         // serve service
//         // -----------------------------------------------------------------------------
//         SERVE_PORT: z.coerce.number().default(3045),
//         SERVE_CACHE_TTL: z.coerce.number().default(86400),
//         SERVE_CORS_ORIGINS: z.string().default("*"),
//     },

//     runtimeEnv: process.env,

//     // IMPORTANT: ensure only expected vars are exposed
//     skipValidation: false,
// });
