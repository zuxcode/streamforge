import { createEnv } from '@t3-oss/env-core';
import { sharedEnv } from './shared.env';

export const queueUiEnv = () =>
  createEnv({
    extends: [sharedEnv()],
    server: {},
    runtimeEnv: process.env,

    // IMPORTANT: ensure only expected vars are exposed
    skipValidation: false,
  });
