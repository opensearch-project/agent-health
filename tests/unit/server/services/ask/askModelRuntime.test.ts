/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * withRefreshingBedrockCredentials — the wrapper's decision table, against a
 * fake pi ModelRuntime: when static keys are injected into the call's `env`
 * (Bedrock, no bearer token, no skip-auth), when the call is left alone, that
 * one provider is created per profile, and that every other member of the
 * runtime passes through bound to the real object. The REAL pi SDK + REAL AWS
 * SDK path (keys rotated on disk mid-process) is askService.realSdk.test.ts.
 */

import { withRefreshingBedrockCredentials, resolveBedrockEnv } from '@/server/services/ask/askModelRuntime';

class FakeRuntime {
  #secret = 'private-field';
  calls: Array<{ name: string; model: any; options: any }> = [];
  auth: any = { auth: {}, env: undefined };
  getAuthCalls: any[] = [];
  getAvailable = async () => [{ provider: 'amazon-bedrock', id: 'm' }];
  async getAuth(model: any, overrides?: any) { this.getAuthCalls.push({ model, overrides }); if (this.auth instanceof Error) throw this.auth; return this.auth; }
  streamSimple(model: any, context: any, options?: any) { this.calls.push({ name: 'streamSimple', model, options }); return { kind: 'stream' }; }
  stream(model: any, context: any, options?: any) { this.calls.push({ name: 'stream', model, options }); return { kind: 'stream' }; }
  secret() { return this.#secret; }
}

const bedrock = { provider: 'amazon-bedrock', id: 'us.anthropic.claude-sonnet-4-6' };
const anthropic = { provider: 'anthropic', id: 'claude-sonnet-4-6' };

function providerFactory() {
  const created: Array<string | undefined> = [];
  let key = 'A';
  const factory = (profile: string | undefined) => {
    created.push(profile);
    return (async () => ({ accessKeyId: `AKID${key}`, secretAccessKey: `secret-${key}`, sessionToken: key === 'A' ? 'token-A' : undefined })) as any;
  };
  return { factory, created, rotate: (k: string) => { key = k; } };
}

describe('withRefreshingBedrockCredentials', () => {
  it('injects the profile\'s CURRENT static keys into every Bedrock call (and shadows AWS_PROFILE so pi installs them)', async () => {
    const rt = new FakeRuntime();
    const pf = providerFactory();
    const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: pf.factory, env: { AWS_PROFILE: 'ops' } });
    const result = await wrapped.streamSimple(bedrock, { messages: [] }, { timeoutMs: 5 });
    expect(result).toEqual({ kind: 'stream' });
    expect(rt.calls[0].options).toEqual({
      timeoutMs: 5,
      env: { AWS_ACCESS_KEY_ID: 'AKIDA', AWS_SECRET_ACCESS_KEY: 'secret-A', AWS_SESSION_TOKEN: 'token-A', AWS_PROFILE: '' },
    });
    expect(pf.created).toEqual(['ops']); // profile taken from the ambient env when pi's resolution has none
    // the file is rotated: the next call carries the new keys — same provider instance, no restart, no new runtime
    pf.rotate('B');
    await wrapped.streamSimple(bedrock, { messages: [] });
    expect(rt.calls[1].name).toBe('streamSimple');
    expect(rt.calls[1].options.env).toEqual({ AWS_ACCESS_KEY_ID: 'AKIDB', AWS_SECRET_ACCESS_KEY: 'secret-B', AWS_SESSION_TOKEN: '', AWS_PROFILE: '' });
    expect(pf.created).toEqual(['ops']);
    // the pi-side auth resolution was consulted with the call's env/signal
    expect(rt.getAuthCalls[0].overrides).toEqual({ env: undefined, signal: undefined });
  });

  it('a profile scoped on pi\'s stored credential (resolution.env.AWS_PROFILE) wins over the ambient one; existing call env is kept', async () => {
    const rt = new FakeRuntime();
    rt.auth = { auth: {}, env: { AWS_PROFILE: 'stored-profile' } };
    const pf = providerFactory();
    const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: pf.factory, env: { AWS_PROFILE: 'ambient' } });
    await wrapped.streamSimple(bedrock, {}, { env: { AWS_REGION: 'eu-west-1' } });
    expect(pf.created).toEqual(['stored-profile']);
    expect(rt.calls[0].options.env).toMatchObject({ AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDA', AWS_PROFILE: '' });
    // explicit per-call profile beats both
    await wrapped.streamSimple(bedrock, {}, { profile: 'explicit' });
    expect(pf.created).toEqual(['stored-profile', 'explicit']);
  });

  it('leaves the call untouched for other providers, bearer-token auth, skip-auth, and when nothing resolves', async () => {
    const pf = providerFactory();
    const untouched = async (rt: FakeRuntime, options?: any, env: NodeJS.ProcessEnv = {}, model: any = bedrock) => {
      const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: pf.factory, env });
      await wrapped.streamSimple(model, {}, options);
      return rt.calls[rt.calls.length - 1].options;
    };
    expect(await untouched(new FakeRuntime(), { x: 1 }, {}, anthropic)).toEqual({ x: 1 });
    const bearerStored = new FakeRuntime(); bearerStored.auth = { auth: { apiKey: 'bearer-xyz' } };
    expect(await untouched(bearerStored, { x: 2 })).toEqual({ x: 2 });
    expect(await untouched(new FakeRuntime(), { apiKey: 'per-call-bearer' })).toEqual({ apiKey: 'per-call-bearer' });
    expect(await untouched(new FakeRuntime(), { x: 3 }, { AWS_BEARER_TOKEN_BEDROCK: 'env-bearer' })).toEqual({ x: 3 });
    expect(await untouched(new FakeRuntime(), { x: 4 }, { AWS_BEDROCK_SKIP_AUTH: '1' })).toEqual({ x: 4 });
    expect(await untouched(new FakeRuntime(), undefined, { AWS_BEDROCK_SKIP_AUTH: '1' })).toBeUndefined();
    expect(pf.created).toEqual([]);
    // pi's own auth resolution throwing → pass through so pi reports its error, not ours
    const broken = new FakeRuntime(); broken.auth = new Error('no auth');
    expect(await untouched(broken, { x: 5 })).toEqual({ x: 5 });
    // the chain finding nothing → pass through to the SDK default chain (pi's error, if any)
    const rt = new FakeRuntime();
    const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: () => (async () => { throw new Error('Could not load credentials from any providers'); }) as any, env: {} });
    await wrapped.streamSimple(bedrock, {}, { x: 6 });
    expect(rt.calls[0].options).toEqual({ x: 6 });
  });

  it('never replaces keys scoped explicitly on the call or on pi\'s stored credential (a chosen principal, not a rotating file)', async () => {
    const pf = providerFactory();
    const rt = new FakeRuntime();
    rt.auth = { auth: {}, env: { AWS_ACCESS_KEY_ID: 'AKIDSTORED', AWS_SECRET_ACCESS_KEY: 'stored-secret' } };
    const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: pf.factory, env: { AWS_PROFILE: 'ops' } });
    await wrapped.streamSimple(bedrock, {}, { x: 1 });
    expect(rt.calls[0].options).toEqual({ x: 1 });
    const rt2 = new FakeRuntime();
    const wrapped2 = withRefreshingBedrockCredentials(rt2 as any, { providerFactory: pf.factory, env: {} });
    await wrapped2.streamSimple(bedrock, {}, { env: { AWS_ACCESS_KEY_ID: 'AKIDCALL', AWS_SECRET_ACCESS_KEY: 's' } });
    expect(rt2.calls[0].options).toEqual({ env: { AWS_ACCESS_KEY_ID: 'AKIDCALL', AWS_SECRET_ACCESS_KEY: 's' } });
    expect(pf.created).toEqual([]);
  });

  it('only streamSimple (the agent loop\'s entry point) is wrapped; stream() keeps its synchronous contract', () => {
    const rt = new FakeRuntime();
    const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: providerFactory().factory, env: {} });
    const direct = wrapped.stream(bedrock, {}, { x: 1 });
    expect(direct).toEqual({ kind: 'stream' }); // not a Promise
    expect(rt.calls[0]).toMatchObject({ name: 'stream', options: { x: 1 } });
  });

  it('every other member passes through bound to the real runtime (private fields keep working)', async () => {
    const rt = new FakeRuntime();
    const wrapped = withRefreshingBedrockCredentials(rt as any, { providerFactory: providerFactory().factory, env: {} });
    expect(wrapped.secret()).toBe('private-field');
    expect(await wrapped.getAvailable()).toEqual([{ provider: 'amazon-bedrock', id: 'm' }]);
    expect(wrapped.calls).toBe(rt.calls);
    expect(wrapped.auth).toBe(rt.auth);
  });

  it('resolveBedrockEnv maps an AWS identity to pi\'s static-key env (session token optional)', async () => {
    expect(await resolveBedrockEnv((async () => ({ accessKeyId: 'a', secretAccessKey: 's', sessionToken: 't' })) as any)).toEqual({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', AWS_PROFILE: '' });
    expect(await resolveBedrockEnv((async () => ({ accessKeyId: 'a', secretAccessKey: 's' })) as any)).toEqual({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: '', AWS_PROFILE: '' });
  });
});
