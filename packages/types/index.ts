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

  /** S3 key where the raw uploaded video is stored. */
  s3Key: string;

  /** Original filename as provided by the uploader. */
  originalFilename: string;

  /** ISO 8601 timestamp of when the upload was received. */
  uploadedAt: string;

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
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

export interface UploadAcceptedResponse {
  jobId: string;
  status: Extract<JobStatus, "queued">;
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