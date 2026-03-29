// ---------------------------------------------------------------------------
// Config
//
// Reads and validates environment variables at import time. Any missing
// required variable causes an immediate crash with a descriptive message
// rather than a cryptic runtime error later in the call stack.
//
// Usage:
//   import { sharedConfig } from "@streamforge/config";
//   import { ingestConfig } from "@streamforge/config";
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `[streamforge/config] Missing required environment variable: ${key}`
    );
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function requirePositiveInt(key: string, fallback?: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `[streamforge/config] Missing required environment variable: ${key}`
    );
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `[streamforge/config] ${key} must be a positive integer, got: "${raw}"`
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Shared config (required by all services)
// ---------------------------------------------------------------------------

export interface SharedConfig {
  redisUrl: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  nodeEnv: "development" | "production" | "test";
  logLevel: "debug" | "info" | "warn" | "error";
}

function loadSharedConfig(): SharedConfig {
  const nodeEnv = optionalEnv("NODE_ENV", "development");
  if (!["development", "production", "test"].includes(nodeEnv)) {
    throw new Error(
      `[streamforge/config] NODE_ENV must be one of: development, production, test. Got: "${nodeEnv}"`
    );
  }

  const logLevel = optionalEnv("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error(
      `[streamforge/config] LOG_LEVEL must be one of: debug, info, warn, error. Got: "${logLevel}"`
    );
  }

  return {
    redisUrl: requireEnv("SF_REDIS_URL"),
    s3Bucket: requireEnv("SF_S3_BUCKET"),
    s3Region: requireEnv("SF_S3_REGION"),
    s3AccessKeyId: requireEnv("SF_S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: requireEnv("SF_S3_SECRET_ACCESS_KEY"),
    nodeEnv: nodeEnv as SharedConfig["nodeEnv"],
    logLevel: logLevel as SharedConfig["logLevel"],
  };
}

export const sharedConfig: SharedConfig = loadSharedConfig();

// ---------------------------------------------------------------------------
// Ingest config
// ---------------------------------------------------------------------------

export interface IngestConfig {
  port: number;

  /** Maximum accepted upload size in bytes. Default: 2 GB. */
  maxUploadSize: number;
}

function loadIngestConfig(): IngestConfig {
  return {
    port: requirePositiveInt("INGEST_PORT", 3000),
    maxUploadSize: requirePositiveInt(
      "INGEST_MAX_UPLOAD_SIZE",
      2 * 1024 * 1024 * 1024
    ),
  };
}

export const ingestConfig: IngestConfig = loadIngestConfig();

// ---------------------------------------------------------------------------
// Transcode config
// ---------------------------------------------------------------------------

export interface TranscodeConfig {
  /** Maximum number of jobs processed in parallel. Default: 2. */
  concurrency: number;

  /** Directory for temporary working files during transcoding. */
  tmpDir: string;

  /** HLS segment duration in seconds. Default: 6. */
  segmentDuration: number;
}

function loadTranscodeConfig(): TranscodeConfig {
  return {
    concurrency: requirePositiveInt("TRANSCODE_CONCURRENCY", 2),
    tmpDir: optionalEnv("TRANSCODE_TMP_DIR", "/tmp/streamforge"),
    segmentDuration: requirePositiveInt("TRANSCODE_SEGMENT_DURATION", 6),
  };
}

export const transcodeConfig: TranscodeConfig = loadTranscodeConfig();

// ---------------------------------------------------------------------------
// Serve config
// ---------------------------------------------------------------------------

export interface ServeConfig {
  port: number;

  /**
   * Cache-Control max-age for .ts segments in seconds.
   * Segments are immutable so this can be long-lived. Default: 86400 (1 day).
   */
  segmentCacheTtl: number;

  /** Comma-separated list of allowed CORS origins. Default: "*". */
  corsOrigins: string[];
}

function loadServeConfig(): ServeConfig {
  const rawOrigins = optionalEnv("SERVE_CORS_ORIGINS", "*");
  const corsOrigins =
    rawOrigins === "*"
      ? ["*"]
      : rawOrigins.split(",").map((o) => o.trim()).filter(Boolean);

  return {
    port: requirePositiveInt("SERVE_PORT", 3002),
    segmentCacheTtl: requirePositiveInt("SERVE_CACHE_TTL", 86400),
    corsOrigins,
  };
}

export const serveConfig: ServeConfig = loadServeConfig();