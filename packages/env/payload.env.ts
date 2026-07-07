import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const payloadEnv = () =>
  createEnv({
    server: {
      SERVER_ENDPOINT: z.string().min(1),
      SERVER_API_KEY: z.string().min(1),
    },
    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
  });
