# Roadmap

This document outlines the planned development phases for streamforge. Each phase builds directly on the last — no phase begins until the previous one is stable, tested, and merged.

---

## Phase 1 — Foundation
**Goal:** Monorepo is set up, all three services boot, and a video can travel end-to-end through the system in a local environment.

### Monorepo & Tooling
- [X] Initialise Bun workspace with `package.json` at root
- [ ] Create `tsconfig.base.json` with `strict: true` and shared path aliases
- [ ] Create `bunfig.toml` with workspace-aware resolution
- [ ] Add `.gitignore` covering `node_modules`, `.env`, `dist`, temp files
- [ ] Scaffold `apps/ingest`, `apps/transcode`, `apps/serve` with empty `index.ts` and `package.json`
- [ ] Scaffold `packages/@streamforge/types`, `queue`, `storage`, `config` with empty entry points

### Shared Packages
- [ ] `@streamforge/types` — define `TranscodeJob`, `JobStatus`, `HlsOutput` interfaces
- [ ] `@streamforge/config` — env schema with validation; crash on missing required vars
- [ ] `@streamforge/queue` — BullMQ queue name constants, job type definitions, producer helper
- [ ] `@streamforge/storage` — `bun:s3` client wrapper with `upload`, `download`, `exists`, `delete`

### `ingest` — Skeleton
- [ ] Hono app boots on `INGEST_PORT`
- [ ] `POST /upload` route accepts `multipart/form-data`
- [ ] File type and size validation
- [ ] Stream upload to S3 under `raw/<jobId>/original.mp4`
- [ ] Enqueue BullMQ job with correct payload shape
- [ ] Structured JSON responses for `202`, `400`, `413`, `500`
- [ ] `GET /health` returns `200 OK`

### `transcode` — Skeleton
- [ ] BullMQ worker boots and connects to Redis
- [ ] Picks up job, downloads raw file from S3 to temp path
- [ ] Invokes `ffmpeg` to produce HLS output (single 720p rendition, 6s segments)
- [ ] Uploads `.ts` segments then `.m3u8` manifest to `processed/<jobId>/`
- [ ] Cleans up temp files on success and failure
- [ ] Marks job `completed` or `failed` correctly
- [ ] `GET /health` returns `200 OK`

### `serve` — Skeleton
- [ ] Hono app boots on `SERVE_PORT`
- [ ] `GET /stream/:id/index.m3u8` — proxies manifest from S3
- [ ] `GET /stream/:id/:segment.ts` — proxies segments from S3
- [ ] Correct `Content-Type` headers on all routes
- [ ] `Range` header support, `206 Partial Content` responses
- [ ] CORS headers on all responses
- [ ] `GET /health` returns `200 OK`

### Infrastructure
- [ ] `Dockerfile` for each service (Bun base image, non-root user)
- [ ] `docker-compose.yml` — wires `ingest`, `transcode`, `serve`, Redis, and a local S3-compatible service
- [ ] `.env.example` with all required variables documented

### Milestone
> A `.mp4` uploaded to `ingest` is transcoded by `transcode` and playable via `serve` using a local HLS player. All three services run via `docker compose up`.

---

## Phase 2 — Reliability
**Goal:** The system handles failure gracefully. No job is silently lost, no partial output is served, and every service shuts down cleanly.

### Error Handling
- [ ] `ingest` — distinguish S3 write failure from queue failure; return correct status for each
- [ ] `ingest` — job deduplication: reject a second enqueue for the same `jobId`
- [ ] `transcode` — classify errors as retriable (transient S3, Redis blip) vs terminal (corrupt video, unsupported codec)
- [ ] `transcode` — terminal errors mark job `failed` permanently; retriable errors re-throw for BullMQ backoff
- [ ] `transcode` — never write the `.m3u8` manifest until all `.ts` segments are confirmed uploaded
- [ ] `serve` — never return a partial manifest body; return `500` if S3 stream is interrupted
- [ ] `serve` — `404` for missing keys must not expose the internal S3 path

### Graceful Shutdown
- [ ] All services handle `SIGTERM` and `SIGINT`
- [ ] `ingest` — drain in-flight HTTP requests before exit
- [ ] `transcode` — wait for the current job to complete (or reach a safe checkpoint) before exit
- [ ] `serve` — drain in-flight streaming responses before exit

### Retry Configuration
- [ ] BullMQ retry count and exponential backoff configured in `@streamforge/queue`
- [ ] Maximum job age and stalled job detection configured
- [ ] Failed jobs retained in queue for inspection (configurable TTL)

### Temp File Safety
- [ ] `transcode` — temp directory is scoped per `jobId`, not shared
- [ ] Cleanup runs in a `finally` block — guaranteed even on unhandled exceptions
- [ ] Stale temp directories older than a configurable threshold are purged on worker startup

### Milestone
> Killing Redis mid-transcode, crashing `transcode` during upload, and sending a malformed request to `ingest` all produce the correct, observable outcomes with no data loss or silent failure.

---

## Phase 3 — Observability
**Goal:** Every meaningful event is logged. The system can be debugged from logs alone.

### Structured Logging
- [ ] All services emit JSON logs with: `level`, `message`, `service`, `timestamp`, `requestId` (where applicable)
- [ ] Request logs include: method, path, status, duration, content length
- [ ] Job logs include: `jobId`, lifecycle event, duration at each stage
- [ ] No secrets (credentials, tokens, connection strings) appear in any log line
- [ ] Log level is configurable per service via env var (`LOG_LEVEL`)

### Request Tracing
- [ ] `ingest` generates a `requestId` per upload and includes it in the job payload
- [ ] `transcode` propagates `requestId` through all job log lines
- [ ] `serve` logs `requestId` from query param or header if provided by client

### Failure Visibility
- [ ] `transcode` logs `ffmpeg` exit code, stderr tail, and wall-clock duration on every run
- [ ] `serve` logs the resolved S3 key on every `404` for debugging missing assets
- [ ] `ingest` logs queue depth at time of enqueue

### Health Checks
- [ ] `GET /health` extended to include dependency status: Redis reachability, S3 reachability
- [ ] Returns `200` only when all dependencies are reachable; `503` otherwise
- [ ] Response body includes per-dependency status: `{ redis: "ok", s3: "ok" }`

### Milestone
> Any failure in the system — from a bad upload to a crashed worker — can be fully diagnosed using log output alone, without attaching a debugger or inspecting internal state.

---

## Phase 4 — Testing
**Goal:** All critical paths are covered by automated tests. CI runs the full suite on every push.

### `ingest` Tests
- [ ] Unit: file type validation, size limit enforcement, job payload construction
- [ ] Unit: error response shapes for each failure mode
- [ ] Integration: `POST /upload` → job appears in queue (real Redis)
- [ ] Integration: S3 write failure → no job enqueued, correct error returned
- [ ] Integration: duplicate `jobId` → second enqueue rejected

### `transcode` Tests
- [ ] Unit: `ffmpeg` argument construction for each output config
- [ ] Unit: segment naming and S3 key generation
- [ ] Unit: error classification (retriable vs terminal)
- [ ] Integration: worker picks up job, produces valid HLS from fixture video
- [ ] Integration: `.m3u8` manifest is valid and references correct segment paths
- [ ] Integration: temp files cleaned up after success and failure

### `serve` Tests
- [ ] Unit: `Content-Type` mapping per file extension
- [ ] Unit: `Range` header parsing and `206` response construction
- [ ] Unit: CORS header presence and correctness
- [ ] Integration: `GET /stream/:id/index.m3u8` returns valid manifest
- [ ] Integration: `GET /stream/:id/:segment.ts` with `Range` header returns `206`
- [ ] Integration: missing S3 key returns `404` without exposing S3 path

### Shared Package Tests
- [ ] `@streamforge/config` — throws on missing required vars, passes on valid env
- [ ] `@streamforge/queue` — job payload serialisation and deserialisation round-trips correctly
- [ ] `@streamforge/storage` — upload, download, exists, delete behave correctly against a local S3

### CI Pipeline
- [ ] Lint and type-check all packages on every push
- [ ] Run full test suite on every push
- [ ] Fail the build on any type error or test failure
- [ ] Cache Bun install and test artifacts between runs

### Milestone
> `bun test` runs green from a clean clone. CI blocks merges on any failure.

---

## Phase 5 — Production Readiness
**Goal:** The system is ready to run in a real environment with multiple replicas, proper access control, and safe configuration management.

### Security
- [ ] `ingest` — validate file content (not just MIME type header) before accepting upload
- [ ] `ingest` — enforce a hard per-request timeout to prevent hung uploads
- [ ] `serve` — validate `:id` path parameter format before constructing S3 key (prevent path traversal)
- [ ] All services — TLS termination handled at the proxy layer; services only bind to internal interfaces
- [ ] Docker images — non-root user, minimal base image, no dev dependencies in production image

### Configuration
- [ ] All secrets managed via environment variables — no hardcoded values anywhere
- [ ] `@streamforge/config` — distinct validation schemas for `development` and `production` environments
- [ ] `docker-compose.yml` updated with production-appropriate resource limits and restart policies

### Scalability
- [ ] `transcode` — multiple worker replicas can run concurrently without job conflicts (BullMQ handles this natively; verify under load)
- [ ] `serve` — stateless design confirmed — any number of replicas can run behind a load balancer
- [ ] `ingest` — stateless design confirmed — safe to scale horizontally

### Deployment
- [ ] Docker images tagged with semver on release
- [ ] `docker-compose.yml` separated into `docker-compose.yml` (base) and `docker-compose.prod.yml` (overrides)
- [ ] Production environment variables documented in `infra/.env.example` with descriptions for every key
- [ ] Each service has a documented startup order and dependency (Redis must be up before `transcode` and `ingest`)

### Milestone
> The system runs in a production environment behind a reverse proxy, with all three services scaling independently and no hardcoded configuration.

---

## Backlog — Future Considerations

Items below are deliberately out of scope for the current phases. They are recorded here to prevent scope creep and to inform future planning.

- **Multiple output renditions** — transcode to 360p, 480p, 720p, 1080p and generate a master playlist for adaptive bitrate streaming
- **Job status API** — `GET /jobs/:id/status` on `ingest` to poll transcoding progress
- **Webhook callbacks** — notify a caller-provided URL when transcoding completes or fails
- **Upload resumption** — multipart or chunked upload protocol for large files
- **Authentication** — API key or JWT validation on `ingest` and optionally on `serve`
- **Video metadata extraction** — duration, codec, resolution, framerate stored alongside the job
- **Admin queue interface** — UI for inspecting failed jobs, retrying manually, and viewing queue depth
- **Metrics** — Prometheus-compatible `/metrics` endpoint on each service