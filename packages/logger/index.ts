import { sharedEnv } from "@streamforge/env";
import pino from "pino";

const env = sharedEnv();
const isProduction = env.NODE_ENV === "production";

export const logger = pino({
    level: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),
    timestamp: pino.stdTimeFunctions.isoTime,

    // Pretty-print in development only; structured JSON in production
    ...(!isProduction && {
        transport: {
            target: "pino-pretty",
            options: {
                colorize: true,
                translateTime: "SYS:standard",
            },
        },
    }),

    formatters: {
        level(label) {
            return { level: label.toUpperCase() };
        },
    },

    base: {
        pid: process.pid,
        service: "streamforge",
        env: env.NODE_ENV ?? "development",
    },

    // Prevent accidental credential leakage in logs
    redact: {
        paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "*.password",
            "*.token",
            "*.refreshToken",
            "*.secret",
            "*.accessKey",
            "*.secretAccessKey",
            "*.apiKey",
        ],
        censor: "[REDACTED]",
    },
});

// Flush pending writes (transport runs on a worker thread and is async)
// before exiting, so the fatal log line isn't lost.
process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    logger.flush(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
    logger.fatal(
        { err: reason instanceof Error ? reason : new Error(String(reason)) },
        "Unhandled rejection",
    );
    logger.flush(() => process.exit(1));
});

export const createLogger = (service: string) => logger.child({ service });
