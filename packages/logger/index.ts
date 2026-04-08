import { sharedEnv } from "@streamforge/env";
import pino from "pino";

const isProduction = sharedEnv.NODE_ENV === "production";

export const logger = pino({
    level: sharedEnv.LOG_LEVEL ?? (isProduction ? "info" : "debug"),

    timestamp: pino.stdTimeFunctions.isoTime,

    // Pretty-print in development; structured JSON in production
    transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
    },

    formatters: {
        level(label) {
            return { level: label.toUpperCase() };
        },
    },

    base: {
        pid: process.pid,
        service: "streamforge",
        env: sharedEnv.NODE_ENV ?? "development",
    },

    // Prevent accidental credential leakage in logs
    redact: {
        paths: [
            "req.headers.authorization",
            "*.password",
            "*.token",
            "*.secret",
            "*.accessKey",
            "*.secretAccessKey",
        ],
        censor: "[REDACTED]",
    },
});

process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logger.fatal(
        { err: reason instanceof Error ? reason : new Error(String(reason)) },
        "Unhandled rejection",
    );
    process.exit(1);
});

export const createLogger = (service: string) => logger.child({ service });
