/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Contract test against the REAL opensearch-js `AwsSigv4Signer` transport
 * (not mocked, unlike opensearchClientFactory.test.ts) proving the actual
 * production bug and its fix end-to-end:
 *
 *   - documents that opensearch-js's own credential-expiry check, applied to
 *     credentials with NO `expiration` (exactly what `ada`-written
 *     ~/.aws/credentials profiles produce), never re-invokes `getCredentials()`
 *     after the first request — the root cause of the "must restart after ada
 *     rotation" bug;
 *   - proves our fix (`resolveSigv4Credentials()` attaching a synthetic
 *     `expiration`) makes the SAME real opensearch-js transport re-invoke
 *     `getCredentials()` again once that window elapses, and that a
 *     mocked "rotated" credential is what a subsequent request actually
 *     picks up.
 *
 * Only `@aws-sdk/credential-providers` is mocked; `@opensearch-project/opensearch`
 * and its `aws-v3` signer run for real. Requests target an address nothing is
 * listening on (127.0.0.1:1) so they fail fast with a connection error *after*
 * opensearch-js has already made its credential-refresh decision — we only
 * care about that decision, not the network outcome.
 */

const mockFromNodeProviderChain = jest.fn();
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: mockFromNodeProviderChain,
}));

import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';
import {
  createOpenSearchClient,
  resolveSigv4Credentials,
  SIGV4_CREDENTIAL_REFRESH_WINDOW_MS,
} from '@/server/services/opensearchClientFactory';
import type { ClusterConfig } from '@/types';

const UNROUTABLE_NODE = 'https://127.0.0.1:1';

async function fireAndIgnore(client: Client) {
  try {
    await client.cluster.health({ timeout: '10ms' });
  } catch {
    // Expected: nothing is listening on 127.0.0.1:1. We only care that
    // opensearch-js made its credential-refresh decision before failing.
  }
}

describe('SigV4 credential refresh — real opensearch-js transport contract', () => {
  let nowSpy: jest.SpyInstance<number, []>;
  let currentTime: number;

  beforeEach(() => {
    jest.clearAllMocks();
    currentTime = Date.now();
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('documents the bug: with NO expiration on the resolved credentials, the real opensearch-js transport never calls getCredentials() again, even across a 1h+ gap', async () => {
    // Mirrors exactly what fromNodeProviderChain({profile}) returns for a real
    // ada-written ~/.aws/credentials profile: no `expiration` field.
    let calls = 0;
    const rawSigner = AwsSigv4Signer({
      region: 'us-east-1',
      service: 'es',
      getCredentials: async () => {
        calls++;
        return { accessKeyId: `key-${calls}`, secretAccessKey: 's', sessionToken: 't' };
      },
    });
    const client = new Client({
      ...rawSigner,
      node: UNROUTABLE_NODE,
      ssl: { rejectUnauthorized: false },
      requestTimeout: 30000,
    });

    await fireAndIgnore(client);
    expect(calls).toBe(1);

    // Advance well past any reasonable rotation window (1 hour).
    currentTime += 60 * 60 * 1000;
    await fireAndIgnore(client);

    // This is the bug: opensearch-js's own expiry check never fires again
    // for expiration-less credentials, so it keeps signing with the FIRST
    // key forever — exactly what wedges a long-running server after `ada`
    // rotates the profile underneath it.
    expect(calls).toBe(1);
  });

  it('proves the fix: resolveSigv4Credentials()\'s synthetic expiration makes the SAME real transport re-invoke getCredentials() once the refresh window elapses', async () => {
    mockFromNodeProviderChain
      .mockReturnValueOnce(jest.fn().mockResolvedValue({ accessKeyId: 'STALE_KEY_BEFORE_ROTATION', secretAccessKey: 's1' }))
      .mockReturnValueOnce(jest.fn().mockResolvedValue({ accessKeyId: 'FRESH_KEY_AFTER_ADA_ROTATION', secretAccessKey: 's2' }));

    const resolvedKeys: string[] = [];
    const signer = AwsSigv4Signer({
      region: 'us-east-1',
      service: 'es',
      getCredentials: async () => {
        const creds = await resolveSigv4Credentials('default');
        resolvedKeys.push(creds.accessKeyId as string);
        return creds;
      },
    });
    const client = new Client({
      ...signer,
      node: UNROUTABLE_NODE,
      ssl: { rejectUnauthorized: false },
      requestTimeout: 30000,
    });

    await fireAndIgnore(client);
    expect(resolvedKeys).toEqual(['STALE_KEY_BEFORE_ROTATION']);

    // Not yet past the refresh window: the real transport must NOT re-call
    // getCredentials (still within the synthetic expiration).
    currentTime += 60 * 1000; // +1 minute
    await fireAndIgnore(client);
    expect(resolvedKeys).toEqual(['STALE_KEY_BEFORE_ROTATION']);

    // `ada credentials update` rewrites ~/.aws/credentials here, in-process,
    // no restart. Once the synthetic expiration elapses, the real
    // opensearch-js transport decides the cached credentials are stale and
    // calls getCredentials() again on its own — which now surfaces the
    // rotated key.
    currentTime += SIGV4_CREDENTIAL_REFRESH_WINDOW_MS;
    await fireAndIgnore(client);
    expect(resolvedKeys).toEqual(['STALE_KEY_BEFORE_ROTATION', 'FRESH_KEY_AFTER_ADA_ROTATION']);
  });

  it('createOpenSearchClient() end-to-end: the wired getCredentials hook is honored by the real signer/transport (integration of our factory + opensearch-js, not just our helper in isolation)', async () => {
    mockFromNodeProviderChain.mockReturnValue(
      jest.fn().mockResolvedValue({ accessKeyId: 'a', secretAccessKey: 'b' })
    );
    const config: ClusterConfig = {
      endpoint: UNROUTABLE_NODE,
      authType: 'sigv4',
      awsRegion: 'us-east-1',
    };

    const client = createOpenSearchClient(config);
    await fireAndIgnore(client);

    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(1);
  });
});
