/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential rotation for the assistant's pi `ModelRuntime`.
 *
 * pi's Bedrock provider builds `new BedrockRuntimeClient(config)` per model
 * call. Unless the call carries static keys, that client resolves credentials
 * through the AWS SDK's default chain, and the SDK caches the shared
 * credentials FILE contents process-wide — a profile rotated on disk is never
 * re-read for the life of the server (same bug class as #569; the rest of the
 * server uses `lib/aws/refreshingCredentialProvider.ts`). Recreating the
 * `ModelRuntime` does not help: the cache is in the SDK's ini-file loader, not
 * in the runtime.
 *
 * pi DOES honour per-call static keys: `options.env.AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN` become `config.credentials`
 * (see `getConfiguredBedrockCredentials` in pi-ai's bedrock-converse-stream),
 * and an explicit `credentials` beats `config.profile` in the SDK. So this
 * wrapper resolves the profile's keys through the REFRESHING provider on every
 * model call and injects them as that env — rotated keys are picked up within
 * {@link DEFAULT_CREDENTIAL_TTL_MS} without a restart, on live sessions too.
 *
 * Only the Bedrock provider is touched, and only when it is NOT using a bearer
 * token (`AWS_BEARER_TOKEN_BEDROCK` / stored api key) or `AWS_BEDROCK_SKIP_AUTH`.
 * If the chain cannot resolve anything the call falls through unchanged and pi
 * reports its own auth error.
 */

import { debug } from '@/lib/debug';
import {
  createRefreshingCredentialProvider,
  type AwsCredentialIdentityProvider,
} from '@/lib/aws/refreshingCredentialProvider';

export const BEDROCK_PROVIDER_ID = 'amazon-bedrock';

/** The slice of pi's ModelRuntime this wrapper intercepts (typed loosely: the SDK is an optional dep). */
export interface PiModelRuntimeLike {
  getAuth(model: any, overrides?: any): Promise<{ auth?: { apiKey?: string }; env?: Record<string, string> } | undefined>;
  streamSimple(model: any, context: any, options?: any): unknown;
  stream(model: any, context: any, options?: any): unknown;
  [key: string]: any;
}

export interface RefreshingBedrockOptions {
  /** Injectable for tests: how a profile name becomes a credential provider. */
  providerFactory?: (profile: string | undefined) => AwsCredentialIdentityProvider;
  /** Injectable for tests. */
  env?: NodeJS.ProcessEnv;
}

/** Static-key env pi's Bedrock path turns into `config.credentials`. */
export async function resolveBedrockEnv(
  provider: AwsCredentialIdentityProvider
): Promise<Record<string, string>> {
  const c = await provider();
  return {
    AWS_ACCESS_KEY_ID: c.accessKeyId,
    AWS_SECRET_ACCESS_KEY: c.secretAccessKey,
    AWS_SESSION_TOKEN: c.sessionToken ?? '',
    // pi only installs static keys when no profile is scoped on the call; an
    // explicit empty value shadows a stored-credential AWS_PROFILE without
    // touching the process env.
    AWS_PROFILE: '',
  };
}

/**
 * Wrap a pi ModelRuntime so every Bedrock model call signs with credentials
 * resolved NOW (refreshing provider), not with whatever the AWS SDK cached at
 * first use. Every other member of the runtime is passed through untouched.
 */
export function withRefreshingBedrockCredentials<T extends PiModelRuntimeLike>(runtime: T, opts: RefreshingBedrockOptions = {}): T {
  const env = opts.env ?? process.env;
  const factory = opts.providerFactory ?? ((profile) => createRefreshingCredentialProvider(profile ? { profile } : {}));
  const providers = new Map<string, AwsCredentialIdentityProvider>();
  const providerFor = (profile: string | undefined) => {
    const key = profile ?? '';
    let p = providers.get(key);
    if (!p) { p = factory(profile); providers.set(key, p); }
    return p;
  };

  const credentialEnv = async (model: any, options: any): Promise<Record<string, string> | undefined> => {
    if (model?.provider !== BEDROCK_PROVIDER_ID) return undefined;
    const callEnv = { ...(options?.env ?? {}) };
    if ((callEnv.AWS_BEDROCK_SKIP_AUTH ?? env.AWS_BEDROCK_SKIP_AUTH) === '1') return undefined;
    let resolution: Awaited<ReturnType<PiModelRuntimeLike['getAuth']>>;
    try {
      resolution = await runtime.getAuth(model, { env: options?.env, signal: options?.signal });
    } catch {
      return undefined; // let pi surface its own auth error
    }
    const merged = { ...(resolution?.env ?? {}), ...callEnv };
    const bearer = options?.apiKey || resolution?.auth?.apiKey || merged.AWS_BEARER_TOKEN_BEDROCK || env.AWS_BEARER_TOKEN_BEDROCK;
    if (bearer) return undefined;
    // Keys scoped explicitly on the call or on pi's stored credential are a
    // chosen principal, not a file that rotates: never replace them.
    if (merged.AWS_ACCESS_KEY_ID && merged.AWS_SECRET_ACCESS_KEY) return undefined;
    const profile = options?.profile || merged.AWS_PROFILE || env.AWS_PROFILE || undefined;
    try {
      return await resolveBedrockEnv(providerFor(profile));
    } catch (err: any) {
      debug('Ask', 'bedrock credential refresh failed; falling back to the SDK chain:', err?.message ?? String(err));
      return undefined;
    }
  };

  // The agent loop's `streamFn` is `async (…) => modelRuntime.streamSimple(…)`,
  // so a Promise of the stream is transparent to it. Only that entry point is
  // wrapped: `stream()` is documented as returning its stream synchronously and
  // nothing on the agent path calls it.
  const streamSimple = async (model: any, context: any, options?: any) => {
    const injected = await credentialEnv(model, options);
    const next = injected ? { ...(options ?? {}), env: { ...(options?.env ?? {}), ...injected } } : options;
    return runtime.streamSimple(model, context, next);
  };

  // A Proxy keeps `this` bound to the real runtime for every untouched member
  // (pi reads private fields through getters).
  const overrides: Record<string, unknown> = { streamSimple };
  return new Proxy(runtime, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      const value = (target as any)[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
