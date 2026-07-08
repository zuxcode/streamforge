import { PayloadSDK } from '@payloadcms/sdk';
import { payloadEnv } from '@streamforge/env';
import type { Config } from '@streamforge/types';

type StrategyKey = 'apiKey' | 'token';
type StrategyValue = 'users API-Key' | 'Bearer';
type StrategyMap = {
  [key in StrategyKey]: StrategyValue;
};

/**
 * Suggested timeout presets for common call sites. Latency-sensitive,
 * on-the-hot-path callers (e.g. per-request auth middleware) should fail
 * fast; background/non-request-lifecycle callers (e.g. afterDelete hooks,
 * scheduled jobs) can tolerate a longer wait before giving up.
 */
export const PAYLOAD_CLIENT_TIMEOUTS = {
  /** Per-request auth checks — fail fast rather than stack up slow requests. */
  AUTH_MIDDLEWARE_MS: 4_000,
  /** Non-request-lifecycle background work (hooks, CLI, scheduled jobs). */
  BACKGROUND_MS: 10_000,
} as const;

interface PayloadClientOptions {
  token: string;
  strategy?: StrategyKey;
  /**
   * Request timeout in milliseconds. Applied via AbortSignal so a hung
   * connection to the Payload server doesn't block the caller
   * indefinitely. Prefer one of PAYLOAD_CLIENT_TIMEOUTS over a bare
   * number so the choice is deliberate and consistent across call sites.
   * Default: PAYLOAD_CLIENT_TIMEOUTS.BACKGROUND_MS.
   */
  timeoutMs?: number;
  /**
   * Optional externally-owned AbortSignal (e.g. from the incoming HTTP
   * request), combined with the timeout so callers can also cancel in
   * response to their own upstream disconnecting.
   */
  signal?: AbortSignal;
}

export function payloadClient({
  token,
  strategy = 'token',
  timeoutMs = PAYLOAD_CLIENT_TIMEOUTS.BACKGROUND_MS,
  signal,
}: PayloadClientOptions) {
  const strategyType = {
    apiKey: 'users API-Key',
    token: 'Bearer',
  } satisfies StrategyMap;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  return new PayloadSDK<Config>({
    baseURL: payloadEnv().SERVER_ENDPOINT,
    baseInit: {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${strategyType[strategy]} ${token}`,
      },
      signal: combinedSignal,
    },
  });
}