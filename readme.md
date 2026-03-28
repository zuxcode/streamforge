# streamforge

A monorepo for video ingestion, transcoding, and adaptive streaming. Built with Bun, Hono, and TypeScript.

---

## Services

| Service | Package | Responsibility |
|---|---|---|
| **ingest** | `apps/ingest` | Accepts video uploads, validates input, enqueues transcoding jobs |
| **transcode** | `apps/transcode` | Consumes jobs from the queue, transcodes video to HLS format |
| **serve** | `apps/serve` | Delivers `.m3u8` manifests and `.ts` segments to clients |

---

## Tech Stack

- **Runtime** — [Bun](https://bun.sh)
- **Framework** — [Hono](https://hono.dev)
- **Language** — TypeScript
- **Queue** — [BullMQ](https://docs.bullmq.io) + [ioredis](https://github.com/redis/ioredis)
- **Storage** — `bun:s3`

---

## Repository Structure

```
streamforge/
├── apps/
│   ├── ingest/                     # Video processing API
│   │   ├── src/
│   │   │   ├── routes/             # Hono route definitions
│   │   │   ├── handlers/           # Request handler logic
│   │   │   └── queues/             # BullMQ job producers
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   └── integration/
│   │   ├── Dockerfile
│   │   └── index.ts
│   │
│   ├── transcode/                  # Worker service
│   │   ├── src/
│   │   │   ├── workers/            # BullMQ worker definitions
│   │   │   ├── processors/         # Transcoding and HLS generation
│   │   │   └── utils/              # Shared helpers (ffmpeg wrappers, etc.)
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── fixtures/           # Small test .mp4 files
│   │   ├── Dockerfile
│   │   └── index.ts
│   │
│   └── serve/                      # Streaming service
│       ├── src/
│       │   ├── routes/             # Hono route definitions
│       │   └── middleware/         # CORS, range request handling, caching
│       ├── tests/
│       │   ├── unit/
│       │   └── integration/
│       ├── Dockerfile
│       └── index.ts
│
├── packages/
│   ├── @streamforge/queue          # BullMQ job definitions and shared types
│   ├── @streamforge/storage        # bun:s3 client wrapper
│   ├── @streamforge/config         # Env schema and shared constants
│   └── @streamforge/types          # Shared TypeScript interfaces
│
├── infra/
│   ├── docker-compose.yml
│   └── .env.example
│
├── package.json                    # Workspace root
├── tsconfig.base.json
├── bunfig.toml
└── .gitignore
```

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) `>= 1.0`
- [Redis](https://redis.io) (for the job queue)
- `ffmpeg` on `PATH` (required by the `transcode` service)

### Install dependencies

```bash
bun install
```

### Configure environment

```bash
cp infra/.env.example infra/.env
```

Edit `infra/.env` and fill in the required values. See [Environment Variables](#environment-variables) for the full reference.

### Run in development

Start all services via Docker Compose (recommended):

```bash
docker compose -f infra/docker-compose.yml up
```

Or run each service individually:

```bash
# Terminal 1 — ingest API
cd apps/ingest && bun run dev

# Terminal 2 — transcode worker
cd apps/transcode && bun run dev

# Terminal 3 — serve
cd apps/serve && bun run dev
```

---

## Environment Variables

All environment variables are validated at startup by `@streamforge/config`. Missing required values will cause a hard crash with a descriptive error.

### Shared

| Variable | Description | Required |
|---|---|---|
| `SF_REDIS_URL` | Redis connection string | Yes |
| `SF_S3_BUCKET` | S3 bucket name for video storage | Yes |
| `SF_S3_REGION` | S3 region | Yes |
| `SF_S3_ACCESS_KEY_ID` | S3 access key | Yes |
| `SF_S3_SECRET_ACCESS_KEY` | S3 secret key | Yes |

### `ingest`

| Variable | Description | Default |
|---|---|---|
| `INGEST_PORT` | HTTP port | `3000` |
| `INGEST_MAX_UPLOAD_SIZE` | Max accepted file size (bytes) | `2147483648` |

### `transcode`

| Variable | Description | Default |
|---|---|---|
| `TRANSCODE_CONCURRENCY` | Max concurrent transcoding jobs | `2` |

### `serve`

| Variable | Description | Default |
|---|---|---|
| `SERVE_PORT` | HTTP port | `3002` |
| `SERVE_CACHE_TTL` | Cache-Control max-age for segments (seconds) | `86400` |

---

## API Reference

### `ingest`

#### `POST /upload`

Accepts a video file upload and enqueues a transcoding job.

**Request** — `multipart/form-data`

| Field | Type | Description |
|---|---|---|
| `file` | File | Video file (`.mp4`) |

**Response** `202 Accepted`

```json
{
  "jobId": "a1b2c3d4",
  "status": "queued"
}
```

---

### `serve`

#### `GET /stream/:id/index.m3u8`

Returns the HLS manifest for a processed video.

#### `GET /stream/:id/:segment.ts`

Returns a video segment. Supports `Range` headers for byte-range requests.

---

## Testing

All services use `bun:test`. Run the full suite from the workspace root:

```bash
bun test
```

Run tests for a specific service:

```bash
cd apps/ingest && bun test
cd apps/transcode && bun test
cd apps/serve && bun test
```

### Test structure

Each service contains `unit/` and `integration/` test directories:

- **Unit tests** — cover individual functions and handlers in isolation, with dependencies mocked.
- **Integration tests** — exercise full request/response cycles and job lifecycle flows against real Redis and S3.

The `transcode` service includes a small fixture video (`tests/fixtures/sample.mp4`) for deterministic HLS output validation.

---

## Docker

Each service has its own `Dockerfile`. Images follow the naming convention `streamforge/<service>:<tag>`.

Build a single service:

```bash
docker build -t streamforge/ingest:latest apps/ingest
```

Build all services via Compose:

```bash
docker compose -f infra/docker-compose.yml build
```

---

## Naming Conventions

| Concern | Convention | Example |
|---|---|---|
| Files and folders | `kebab-case` | `hls-processor.ts`, `video-upload.ts` |
| TypeScript classes and types | `PascalCase` | `TranscodeJob`, `HlsManifest` |
| Environment variables (shared) | `SF_` prefix | `SF_REDIS_URL` |
| Environment variables (service) | `SERVICE_` prefix | `INGEST_PORT` |
| Internal packages | `@streamforge/<name>` | `@streamforge/queue` |
| Docker images | `streamforge/<service>:<tag>` | `streamforge/serve:1.0.0` |
| Exports from packages | Named exports only | `export { createJob }` |

---

## License

MIT