import { PayloadSDK } from '@payloadcms/sdk';
import { payloadEnv } from '../env';
import type { Config } from '../types';

type StrategyKey = 'apiKey' | 'token';
type StrategyValue = 'users API-Key' | 'Bearer';

type StrategyMap = {
  [key in StrategyKey]: StrategyValue;
};

interface PayloadClientOptions {
  token: string;
  strategy?: StrategyKey;
}

export function payloadClient({ token, strategy = 'token' }: PayloadClientOptions) {
  const strategyType = {
    apiKey: 'users API-Key',
    token: 'Bearer',
  } satisfies StrategyMap;

  return new PayloadSDK<Config>({
    baseURL: payloadEnv().SERVER_ENDPOINT,
    baseInit: {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `${strategyType[strategy]} ${token}`,
      },
    },
  });
}
