// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export type JobStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "delayed";

export interface TranscodeJob {
  /** Unique identifier for this job, used as the S3 key prefix. */
  jobId: string;

  /** S3 path where the raw uploaded video is stored. */
  prefix: string;

  /** S3 bucket name where the raw uploaded video is stored. */
  bucketName: string;

  /** raw Filename */
  filename: string;

  /** ISO 8601 timestamp of when the upload was received. */
  uploadedAt: string;

  generateThumbnail: boolean;

  /** Webhook URL to notify when job events finish. */
  webhookUrl?: string | undefined;

  /**
   * Propagated from the ingest request for end-to-end tracing.
   * Present when the caller provided an X-Request-Id header.
   */
  requestId?: string;
}

// ---------------------------------------------------------------------------
// HLS output
// ---------------------------------------------------------------------------

export interface HlsSegment {
  /** S3 key for this segment. */
  s3Key: string;

  /** Segment index, zero-based. */
  index: number;

  /** Duration of this segment in seconds. */
  duration: number;
}

export interface HlsOutput {
  /** S3 key for the .m3u8 manifest. */
  manifestKey: string;

  /** Ordered list of segments referenced by the manifest. */
  segments: HlsSegment[];

  /** Total duration of the video in seconds. */
  totalDuration: number;

  /** Output resolution label, e.g. "720p". */
  rendition: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface UploadAcceptedResponse {
  jobId: string;
  status: Extract<JobStatus, "queued">;
  message: string;
  data: {
    [property: string]: unknown;
  } | null;
}

export interface ErrorResponse {
  error: {
    /** Machine-readable error code. */
    code: string;

    /** Human-readable description. */
    message: string;
  };
}

export interface HealthResponse {
  status: "ok" | "degraded";
  dependencies?: Record<string, "ok" | "unreachable">;
}

export interface FireWebhookPayload {
  event: "job.complete" | "job.failed";
  status: Extract<JobStatus, "completed" | "failed">;
  jobId: string;
  error: string | null;
  data: {
    filename: string;
    durationMs: number;
  } | null;
}

export type onProgress = (progress: {
  stage: number;
  pct: number;
  detail?: string;
}) => void;

export interface UploadResult {
  uploaded: string[];
  failed: Array<{ localPath: string; s3Key: string; error: unknown }>;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Subscription tiers a user can hold. */
export type SubscriptionStatus =
  | "active"
  | "inactive"
  | "trialing"
  | "past_due";

/** Roles that can be assigned to a user. */
export type UserRole = "admin" | "user";

/**
 * The verified user profile returned by the auth service's token introspection
 * endpoint. Produced by @streamforge/auth and consumed by service middleware.
 *
 * This is not a JWT payload — it is the normalised response from calling the
 * external auth provider (Auth0, Clerk, etc.) with an opaque access token.
 */
export interface AuthenticatedUser {
  /** The user's unique ID as assigned by the auth provider. */
  id: string;

  /** Human-readable identifier (email or username). */
  email: string;

  /** The user's assigned role. */
  role: UserRole;

  /** Current subscription status. */
  subscription: SubscriptionStatus;
}
