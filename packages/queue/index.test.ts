// import { describe, expect, it, mock } from "bun:test";
// import {
//     closeQueue,
//     createRedisConnection,
//     type EnqueueResult,
//     enqueueTranscodeJob,
//     getQueueDepth,
//     JOB_NAMES,
//     JOB_OPTIONS,
//     type JobName,
//     QUEUE_NAMES,
//     type QueueName,
// } from ".";
// import type { TranscodeJob } from "@streamforge/types";

// // ---------------------------------------------------------------------------
// // Fixtures
// // ---------------------------------------------------------------------------

// function makePayload(overrides: Partial<TranscodeJob> = {}): TranscodeJob {
//     return {
//         jobId: "3f7a2c91-47d3-4b8e-9f12-abc123def456",
//         s3Key: "raw/3f7a2c91-47d3-4b8e-9f12-abc123def456/original.mp4",
//         originalFilename: "original.mp4",
//         uploadedAt: "2024-06-01T12:00:00.000Z",
//         ...overrides,
//     };
// }

// // ---------------------------------------------------------------------------
// // QUEUE_NAMES
// // ---------------------------------------------------------------------------

// describe("QUEUE_NAMES", () => {
//     it("exports a transcode queue name", () => {
//         expect(QUEUE_NAMES.transcode).toBe("transcode");
//     });

//     it("all values are non-empty strings", () => {
//         for (const name of Object.values(QUEUE_NAMES)) {
//             expect(typeof name).toBe("string");
//             expect(name.length).toBeGreaterThan(0);
//         }
//     });

//     it("is frozen (as const)", () => {
//         // TypeScript `as const` makes this a readonly tuple — verify the value
//         // cannot be changed at runtime
//         expect(() => {
//             (QUEUE_NAMES as Record<string, string>).transcode = "other";
//         }).toThrow();
//     });
// });

// // ---------------------------------------------------------------------------
// // JOB_NAMES
// // ---------------------------------------------------------------------------

// describe("JOB_NAMES", () => {
//     it("exports a transcode job name", () => {
//         expect(JOB_NAMES.transcode).toBe("transcode:process");
//     });

//     it("every job name follows the queue:action namespace convention", () => {
//         for (const name of Object.values(JOB_NAMES)) {
//             expect(name).toContain(":");
//             const [queue, action] = name.split(":");
//             expect(queue!.length).toBeGreaterThan(0);
//             expect(action!.length).toBeGreaterThan(0);
//         }
//     });

//     it("transcode job name references the transcode queue", () => {
//         expect(JOB_NAMES.transcode.startsWith(QUEUE_NAMES.transcode)).toBe(
//             true,
//         );
//     });
// });

// // ---------------------------------------------------------------------------
// // QueueName / JobName type guards
// // ---------------------------------------------------------------------------

// describe("QueueName type", () => {
//     it("accepts valid queue names at runtime", () => {
//         const valid: QueueName[] = [QUEUE_NAMES.transcode];
//         expect(valid).toContain("transcode");
//     });
// });

// describe("JobName type", () => {
//     it("accepts valid job names at runtime", () => {
//         const valid: JobName[] = [JOB_NAMES.transcode];
//         expect(valid).toContain("transcode:process");
//     });
// });

// // ---------------------------------------------------------------------------
// // JOB_OPTIONS
// // ---------------------------------------------------------------------------

// describe("JOB_OPTIONS.transcode", () => {
//     const opts = JOB_OPTIONS.transcode;

//     it("retries more than once", () => {
//         expect(opts.attempts).toBeGreaterThan(1);
//     });

//     it("uses exponential backoff", () => {
//         expect(opts.backoff.type).toBe("exponential");
//     });

//     it("initial backoff delay is positive", () => {
//         expect(opts.backoff.delay).toBeGreaterThan(0);
//     });

//     it("initial backoff delay is at least 1 second", () => {
//         expect(opts.backoff.delay).toBeGreaterThanOrEqual(1_000);
//     });

//     it("retains a meaningful number of completed jobs", () => {
//         expect(opts.removeOnComplete.count).toBeGreaterThan(0);
//     });

//     it("never auto-removes failed jobs (count: 0 = retain all)", () => {
//         expect(opts.removeOnFail.count).toBe(0);
//     });

//     it("total delay across all retries stays under 5 minutes", () => {
//         // Verify the policy does not create unacceptably long retry windows.
//         // Exponential: delay * (2^0 + 2^1 + ... + 2^(attempts-2))
//         const { delay } = opts.backoff;
//         const { attempts } = opts;
//         let total = 0;
//         for (let i = 0; i < attempts - 1; i++) total += delay * 2 ** i;
//         expect(total).toBeLessThan(5 * 60 * 1_000);
//     });
// });

// // ---------------------------------------------------------------------------
// // createRedisConnection
// // ---------------------------------------------------------------------------

// describe("createRedisConnection", () => {
//     it("parses host from redis:// URL", () => {
//         expect(createRedisConnection("redis://localhost:6379").host).toBe(
//             "localhost",
//         );
//     });

//     it("parses port from redis:// URL", () => {
//         expect(createRedisConnection("redis://localhost:6379").port).toBe(6379);
//     });

//     it("defaults port to 6379 when omitted", () => {
//         expect(createRedisConnection("redis://localhost").port).toBe(6379);
//     });

//     it("parses a non-standard port", () => {
//         expect(createRedisConnection("redis://localhost:6380").port).toBe(6380);
//     });

//     it("extracts password from URL", () => {
//         expect(
//             createRedisConnection("redis://:mysecret@localhost:6379").password,
//         ).toBe("mysecret");
//     });

//     it("leaves password undefined when absent", () => {
//         expect(
//             createRedisConnection("redis://localhost:6379").password,
//         ).toBeUndefined();
//     });

//     it("extracts username when present", () => {
//         expect(
//             createRedisConnection("redis://alice:pass@localhost:6379").username,
//         ).toBe("alice");
//     });

//     it("leaves username undefined when absent", () => {
//         expect(
//             createRedisConnection("redis://localhost:6379").username,
//         ).toBeUndefined();
//     });

//     it("enables TLS for rediss:// scheme", () => {
//         expect(createRedisConnection("rediss://localhost:6380").tls)
//             .toBeDefined();
//     });

//     it("does not enable TLS for redis:// scheme", () => {
//         expect(createRedisConnection("redis://localhost:6379").tls)
//             .toBeUndefined();
//     });

//     it("sets maxRetriesPerRequest to null (BullMQ requirement)", () => {
//         expect(
//             createRedisConnection("redis://localhost:6379")
//                 .maxRetriesPerRequest,
//         ).toBeNull();
//     });

//     it("disables offline queue (BullMQ requirement)", () => {
//         expect(
//             createRedisConnection("redis://localhost:6379").enableOfflineQueue,
//         ).toBe(false);
//     });

//     it("sets keepAlive to a positive number of milliseconds", () => {
//         const { keepAlive } = createRedisConnection("redis://localhost:6379");
//         expect(typeof keepAlive).toBe("number");
//         expect(keepAlive as number).toBeGreaterThan(0);
//     });

//     it("returns different configs for different hosts", () => {
//         const a = createRedisConnection("redis://host-a:6379");
//         const b = createRedisConnection("redis://host-b:6379");
//         expect(a.host).not.toBe(b.host);
//     });
// });

// // ---------------------------------------------------------------------------
// // enqueueTranscodeJob — mock queue
// // ---------------------------------------------------------------------------

// function makeMockQueue(jobTimestamp?: number) {
//     const addedJobs: {
//         name: string;
//         data: TranscodeJob;
//         opts: Record<string, unknown>;
//     }[] = [];

//     const mockJob = {
//         id: "3f7a2c91-47d3-4b8e-9f12-abc123def456",
//         // Default timestamp = just now → not deduplicated
//         timestamp: jobTimestamp ?? Date.now(),
//     };

//     return {
//         queue: {
//             add: mock(
//                 async (
//                     name: string,
//                     data: TranscodeJob,
//                     opts: Record<string, unknown>,
//                 ) => {
//                     addedJobs.push({ name, data, opts });
//                     return mockJob;
//                 },
//             ),
//             close: mock(async () => {}),
//             getJobCounts: mock(async (..._states: string[]) => ({
//                 waiting: 3,
//                 active: 1,
//                 delayed: 0,
//             })),
//         } as unknown as import("bullmq").Queue<TranscodeJob>,
//         addedJobs,
//         mockJob,
//     };
// }

// describe("enqueueTranscodeJob", () => {
//     it("returns the jobId from the payload", async () => {
//         const { queue } = makeMockQueue();
//         const payload = makePayload();
//         const result = await enqueueTranscodeJob(queue, payload);
//         expect(result.jobId).toBe(payload.jobId);
//     });

//     it("returns the transcode queue name", async () => {
//         const { queue } = makeMockQueue();
//         const result = await enqueueTranscodeJob(queue, makePayload());
//         expect(result.queueName).toBe(QUEUE_NAMES.transcode);
//     });

//     it("calls queue.add with the transcode job name", async () => {
//         const { queue, addedJobs } = makeMockQueue();
//         await enqueueTranscodeJob(queue, makePayload());
//         expect(addedJobs[0]!.name).toBe(JOB_NAMES.transcode);
//     });

//     it("calls queue.add with the full payload", async () => {
//         const { queue, addedJobs } = makeMockQueue();
//         const payload = makePayload();
//         await enqueueTranscodeJob(queue, payload);
//         expect(addedJobs[0]!.data).toEqual(payload);
//     });

//     it("passes the jobId as the BullMQ job ID option", async () => {
//         const { queue, addedJobs } = makeMockQueue();
//         const payload = makePayload();
//         await enqueueTranscodeJob(queue, payload);
//         expect(addedJobs[0]!.opts.jobId).toBe(payload.jobId);
//     });

//     it("calls queue.add exactly once", async () => {
//         const { queue } = makeMockQueue();
//         await enqueueTranscodeJob(queue, makePayload());
//         expect((queue.add as ReturnType<typeof mock>).mock.calls.length).toBe(
//             1,
//         );
//     });

//     it("result.deduplicated is false for a freshly created job", async () => {
//         const { queue } = makeMockQueue(Date.now());
//         const result = await enqueueTranscodeJob(queue, makePayload());
//         expect(result.deduplicated).toBe(false);
//     });

//     it("result.deduplicated is true when BullMQ returns a pre-existing job", async () => {
//         // Simulate a job whose timestamp is 10 seconds in the past
//         const { queue } = makeMockQueue(Date.now() - 10_000);
//         const result = await enqueueTranscodeJob(queue, makePayload());
//         expect(result.deduplicated).toBe(true);
//     });

//     it("re-throws when queue.add throws", async () => {
//         const { queue } = makeMockQueue();
//         (queue.add as ReturnType<typeof mock>).mockImplementation(async () => {
//             throw new Error("Redis connection refused");
//         });
//         await expect(enqueueTranscodeJob(queue, makePayload())).rejects.toThrow(
//             "Redis connection refused",
//         );
//     });

//     it("EnqueueResult has jobId, queueName, and deduplicated fields", async () => {
//         const { queue } = makeMockQueue();
//         const result: EnqueueResult = await enqueueTranscodeJob(
//             queue,
//             makePayload(),
//         );
//         expect(result).toHaveProperty("jobId");
//         expect(result).toHaveProperty("queueName");
//         expect(result).toHaveProperty("deduplicated");
//     });
// });

// // ---------------------------------------------------------------------------
// // getQueueDepth
// // ---------------------------------------------------------------------------

// describe("getQueueDepth", () => {
//     it("sums waiting + active + delayed", async () => {
//         const { queue } = makeMockQueue();
//         const depth = await getQueueDepth(queue);
//         // mock returns waiting:3, active:1, delayed:0
//         expect(depth).toBe(4);
//     });

//     it("returns 0 when all counts are zero", async () => {
//         const { queue } = makeMockQueue();
//         (queue.getJobCounts as ReturnType<typeof mock>).mockImplementation(
//             async () => ({ waiting: 0, active: 0, delayed: 0 }),
//         );
//         expect(await getQueueDepth(queue)).toBe(0);
//     });

//     it("handles missing count fields gracefully (treats undefined as 0)", async () => {
//         const { queue } = makeMockQueue();
//         (queue.getJobCounts as ReturnType<typeof mock>).mockImplementation(
//             async () => ({}),
//         );
//         expect(await getQueueDepth(queue)).toBe(0);
//     });

//     it("returns -1 when Redis is unreachable (never throws)", async () => {
//         const { queue } = makeMockQueue();
//         (queue.getJobCounts as ReturnType<typeof mock>).mockImplementation(
//             async () => {
//                 throw new Error("ECONNREFUSED");
//             },
//         );
//         const depth = await getQueueDepth(queue);
//         expect(depth).toBe(-1);
//     });

//     it("does not throw even when getJobCounts rejects", async () => {
//         const { queue } = makeMockQueue();
//         (queue.getJobCounts as ReturnType<typeof mock>).mockImplementation(
//             async () => {
//                 throw new Error("timeout");
//             },
//         );
//         await expect(getQueueDepth(queue)).resolves.toBeDefined();
//     });
// });

// // ---------------------------------------------------------------------------
// // closeQueue
// // ---------------------------------------------------------------------------

// describe("closeQueue", () => {
//     it("calls queue.close()", async () => {
//         const { queue } = makeMockQueue();
//         await closeQueue(queue);
//         expect((queue.close as ReturnType<typeof mock>).mock.calls.length).toBe(
//             1,
//         );
//     });

//     it("resolves without error", async () => {
//         const { queue } = makeMockQueue();
//         await expect(closeQueue(queue)).resolves.toBeUndefined();
//     });

//     it("re-throws if queue.close() rejects", async () => {
//         const { queue } = makeMockQueue();
//         (queue.close as ReturnType<typeof mock>).mockImplementation(
//             async () => {
//                 throw new Error("close failed");
//             },
//         );
//         await expect(closeQueue(queue)).rejects.toThrow("close failed");
//     });
// });

// // ---------------------------------------------------------------------------
// // TranscodeJob payload shape
// // ---------------------------------------------------------------------------

// describe("TranscodeJob payload shape", () => {
//     it("all required fields are present in a valid payload", () => {
//         const payload = makePayload();
//         expect(payload.jobId).toBeDefined();
//         expect(payload.s3Key).toBeDefined();
//         expect(payload.originalFilename).toBeDefined();
//         expect(payload.uploadedAt).toBeDefined();
//     });

//     it("requestId is optional", () => {
//         const without = makePayload();
//         expect(without.requestId).toBeUndefined();

//         const with_ = makePayload({ requestId: "req-abc" });
//         expect(with_.requestId).toBe("req-abc");
//     });

//     it("uploadedAt is a valid ISO 8601 string", () => {
//         const { uploadedAt } = makePayload();
//         expect(new Date(uploadedAt).toISOString()).toBe(uploadedAt);
//     });

//     it("jobId is a non-empty string safe to use as a Redis key", () => {
//         const { jobId } = makePayload();
//         expect(typeof jobId).toBe("string");
//         expect(jobId.length).toBeGreaterThan(0);
//         // Redis keys must not contain spaces
//         expect(jobId).not.toContain(" ");
//     });

//     it("s3Key matches the raw video key convention", () => {
//         const payload = makePayload();
//         expect(payload.s3Key.startsWith("raw/")).toBe(true);
//         expect(payload.s3Key).toContain(payload.jobId);
//     });
// });
