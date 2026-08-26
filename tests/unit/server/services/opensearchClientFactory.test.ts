/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Mock @opensearch-project/opensearch
const mockClientConstructor = jest.fn().mockReturnValue({ close: jest.fn() });
jest.mock('@opensearch-project/opensearch', () => ({
  Client: mockClientConstructor,
}));

// Mock AwsSigv4Signer
const mockAwsSigv4Signer = jest.fn().mockReturnValue({
  Connection: 'mock-connection',
});
jest.mock('@opensearch-project/opensearch/aws-v3', () => ({
  AwsSigv4Signer: mockAwsSigv4Signer,
}));

// Mock fromNodeProviderChain
const mockFromNodeProviderChain = jest.fn().mockReturnValue(
  jest.fn().mockResolvedValue({ accessKeyId: 'test', secretAccessKey: 'test' })
);
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: mockFromNodeProviderChain,
}));

import { createOpenSearchClient, configToCacheKey, resolveSigv4Credentials, describeOpenSearchError, opensearchErrorStatusCode, SIGV4_CREDENTIAL_REFRESH_WINDOW_MS } from '@/server/services/opensearchClientFactory';
import type { ClusterConfig } from '@/types';

describe('opensearchClientFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createOpenSearchClient', () => {
    it('should create a basic auth client with username/password', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        username: 'admin',
        password: 'admin123',
      };

      createOpenSearchClient(config);

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          node: 'https://localhost:9200',
          auth: { username: 'admin', password: 'admin123' },
          ssl: { rejectUnauthorized: true },
        })
      );
    });

    it('should create a basic auth client without credentials when not provided', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
      };

      createOpenSearchClient(config);

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          node: 'https://localhost:9200',
          ssl: { rejectUnauthorized: true },
        })
      );
      // No auth property should be set
      const callArg = mockClientConstructor.mock.calls[0][0];
      expect(callArg.auth).toBeUndefined();
    });

    it('should respect tlsSkipVerify=true', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        tlsSkipVerify: true,
      };

      createOpenSearchClient(config);

      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: { rejectUnauthorized: false },
        })
      );
    });

    it('should create a SigV4 client when authType is sigv4', () => {
      const config: ClusterConfig = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          service: 'es',
        })
      );
      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          node: 'https://search-domain.us-east-1.es.amazonaws.com',
          Connection: 'mock-connection',
        })
      );
    });

    it('should pass awsProfile to fromNodeProviderChain', () => {
      const config: ClusterConfig = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
        awsProfile: 'MyProfile',
      };

      createOpenSearchClient(config);

      // Get the getCredentials function that was passed to AwsSigv4Signer
      const signerCall = mockAwsSigv4Signer.mock.calls[0][0];
      expect(signerCall.region).toBe('us-east-1');

      // Call getCredentials to trigger fromNodeProviderChain
      expect(typeof signerCall.getCredentials).toBe('function');
      signerCall.getCredentials();
      expect(mockFromNodeProviderChain).toHaveBeenCalledWith({ profile: 'MyProfile' });
    });

    it('should use aoss service for serverless', () => {
      const config: ClusterConfig = {
        endpoint: 'https://collection.us-east-1.aoss.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
        awsService: 'aoss',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
          service: 'aoss',
        })
      );
    });

    it('should throw error when sigv4 is used without awsRegion', () => {
      const config: ClusterConfig = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
      };

      expect(() => createOpenSearchClient(config)).toThrow(
        'awsRegion is required when authType is "sigv4"'
      );
    });

    // ---- Finding 2: authType validation / inference (no silent basic-auth) ----
    it('infers sigv4 when authType is omitted but awsProfile/awsRegion are present', () => {
      const config = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        awsProfile: 'default',
        awsRegion: 'us-east-1',
        awsService: 'es',
      } as ClusterConfig;

      createOpenSearchClient(config);

      // SigV4 path taken (not basic auth) even though authType was absent.
      expect(mockAwsSigv4Signer).toHaveBeenCalledWith(
        expect.objectContaining({ region: 'us-east-1', service: 'es' })
      );
    });

    it('throws a clear error on an unrecognized authType instead of silently using basic auth', () => {
      const config = {
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'aws', // the real footgun: 'aws' is not a valid authType
        awsProfile: 'default',
        awsRegion: 'us-east-1',
      } as unknown as ClusterConfig;

      expect(() => createOpenSearchClient(config)).toThrow(/Invalid storage\/observability authType 'aws'.*sigv4/);
      // and it must NOT have silently constructed a (doomed) basic-auth client
      expect(mockClientConstructor).not.toHaveBeenCalled();
    });

    it('should create a client with no auth when authType is none', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        authType: 'none',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).not.toHaveBeenCalled();
      expect(mockClientConstructor).toHaveBeenCalledWith({
        node: 'https://localhost:9200',
        ssl: { rejectUnauthorized: true },
      });
      // No auth property should be set
      const callArg = mockClientConstructor.mock.calls[0][0];
      expect(callArg.auth).toBeUndefined();
    });

    it('should default to basic auth when authType is not specified', () => {
      const config: ClusterConfig = {
        endpoint: 'https://localhost:9200',
        username: 'admin',
        password: 'admin',
      };

      createOpenSearchClient(config);

      expect(mockAwsSigv4Signer).not.toHaveBeenCalled();
      expect(mockClientConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { username: 'admin', password: 'admin' },
        })
      );
    });
  });

  describe('resolveSigv4Credentials (refresh behavior)', () => {
    it('creates a fresh provider chain and calls it on every invocation (no memoized/one-shot credentials)', async () => {
      mockFromNodeProviderChain
        .mockReturnValueOnce(jest.fn().mockResolvedValue({ accessKeyId: 'first', secretAccessKey: 's1' }))
        .mockReturnValueOnce(jest.fn().mockResolvedValue({ accessKeyId: 'second', secretAccessKey: 's2' }));

      const first = await resolveSigv4Credentials('MyProfile');
      const second = await resolveSigv4Credentials('MyProfile');

      expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(2);
      expect(first.accessKeyId).toBe('first');
      expect(second.accessKeyId).toBe('second');
    });

    it('attaches a synthetic near-term expiration when the resolved credentials carry none, so opensearch-js will re-invoke getCredentials instead of caching them forever', async () => {
      mockFromNodeProviderChain.mockReturnValueOnce(
        jest.fn().mockResolvedValue({ accessKeyId: 'a', secretAccessKey: 'b' }) // no `expiration`, like ada-written ~/.aws/credentials
      );

      const before = Date.now();
      const credentials: any = await resolveSigv4Credentials();
      const after = Date.now();

      expect(credentials.expiration).toBeInstanceOf(Date);
      const expiresAt = credentials.expiration.getTime();
      expect(expiresAt).toBeGreaterThan(before);
      expect(expiresAt).toBeLessThanOrEqual(after + SIGV4_CREDENTIAL_REFRESH_WINDOW_MS);
    });

    it('honors a real expiration already provided by the credential chain (e.g. genuine STS temporary credentials) instead of overwriting it', async () => {
      const realExpiration = new Date(Date.now() + 60 * 60 * 1000); // 1h out, from STS
      mockFromNodeProviderChain.mockReturnValueOnce(
        jest.fn().mockResolvedValue({ accessKeyId: 'a', secretAccessKey: 'b', expiration: realExpiration })
      );

      const credentials: any = await resolveSigv4Credentials();

      expect(credentials.expiration).toBe(realExpiration);
    });

    // Red→green regression proof for the actual production bug: simulates `ada`
    // rotating the profile mid-process (new access key after the first
    // request) and proves a subsequent getCredentials() call surfaces the
    // rotated key rather than the stale first-resolved one.
    it('simulates expired-then-refreshed credentials: after an ada-style rotation, the next getCredentials() call returns the fresh key', async () => {
      const staleProvider = jest.fn().mockResolvedValue({
        accessKeyId: 'STALE_KEY_BEFORE_ROTATION',
        secretAccessKey: 'stale-secret',
      });
      const rotatedProvider = jest.fn().mockResolvedValue({
        accessKeyId: 'FRESH_KEY_AFTER_ADA_ROTATION',
        secretAccessKey: 'fresh-secret',
      });
      mockFromNodeProviderChain.mockReturnValueOnce(staleProvider).mockReturnValueOnce(rotatedProvider);

      const beforeRotation = await resolveSigv4Credentials('default');
      expect(beforeRotation.accessKeyId).toBe('STALE_KEY_BEFORE_ROTATION');

      // `ada credentials update` rewrites ~/.aws/credentials here, in-process,
      // with no server restart.
      const afterRotation = await resolveSigv4Credentials('default');
      expect(afterRotation.accessKeyId).toBe('FRESH_KEY_AFTER_ADA_ROTATION');
    });
  });

  describe('opensearchErrorStatusCode / describeOpenSearchError', () => {
    it('extracts statusCode directly off the error when present', () => {
      expect(opensearchErrorStatusCode({ statusCode: 500 })).toBe(500);
    });

    it('falls back to error.meta.statusCode (opensearch-js ResponseError shape for a bodiless 403)', () => {
      const err = { message: 'Response Error', meta: { statusCode: 403, body: {} } };
      expect(opensearchErrorStatusCode(err)).toBe(403);
    });

    it('falls back to error.meta.body.status when present', () => {
      const err = { message: 'oops', meta: { body: { status: 502 } } };
      expect(opensearchErrorStatusCode(err)).toBe(502);
    });

    it('returns undefined when no status code is discoverable', () => {
      expect(opensearchErrorStatusCode(new Error('boom'))).toBeUndefined();
      expect(opensearchErrorStatusCode(null)).toBeUndefined();
    });

    it('appends the HTTP status code to the message so a 403 (auth) reads differently from a 5xx (cluster) in logs', () => {
      const authError = { message: 'Response Error', meta: { statusCode: 403, body: {} } };
      const clusterError = { message: 'Response Error', meta: { statusCode: 503, body: {} } };

      expect(describeOpenSearchError(authError)).toBe('Response Error (HTTP 403)');
      expect(describeOpenSearchError(clusterError)).toBe('Response Error (HTTP 503)');
      expect(describeOpenSearchError(authError)).not.toBe(describeOpenSearchError(clusterError));
    });

    it('leaves the message untouched when no status code is available', () => {
      expect(describeOpenSearchError(new Error('Connection refused'))).toBe('Connection refused');
    });

    it('returns an empty string (not "[object Object]") for a message-less, status-less error so callers\' `|| fallback` still applies', () => {
      expect(describeOpenSearchError({})).toBe('');
    });
  });

  describe('configToCacheKey', () => {
    it('should generate basic auth cache key with hashed credentials', () => {
      const key = configToCacheKey({
        endpoint: 'https://localhost:9200',
        username: 'admin',
        password: 'pass',
      });

      expect(key).toMatch(/^basic\|https:\/\/localhost:9200\|[a-f0-9]{16}$/);
      // Password should NOT appear in the key
      expect(key).not.toContain('pass');
      expect(key).not.toContain('admin');
    });

    it('should generate basic auth cache key without credentials', () => {
      const key = configToCacheKey({
        endpoint: 'https://localhost:9200',
      });

      expect(key).toMatch(/^basic\|https:\/\/localhost:9200\|[a-f0-9]{16}$/);
    });

    it('should generate sigv4 cache key', () => {
      const key = configToCacheKey({
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-east-1',
        awsProfile: 'MyProfile',
      });

      expect(key).toBe('sigv4|https://search-domain.us-east-1.es.amazonaws.com|us-east-1|MyProfile|es');
    });

    it('should include awsService in sigv4 cache key', () => {
      const key = configToCacheKey({
        endpoint: 'https://collection.aoss.amazonaws.com',
        authType: 'sigv4',
        awsRegion: 'us-west-2',
        awsService: 'aoss',
      });

      expect(key).toBe('sigv4|https://collection.aoss.amazonaws.com|us-west-2||aoss');
    });

    // Finding-2 follow-up: the cache key MUST reflect the same authType the client
    // is actually built with, including inferred SigV4 (omitted authType + AWS
    // fields). Otherwise inferred-SigV4 configs collide on a 'basic|...' key.
    it('uses a sigv4 key (not basic) when authType is inferred from AWS fields', () => {
      const key = configToCacheKey({
        endpoint: 'https://search-domain.us-east-1.es.amazonaws.com',
        awsProfile: 'default',
        awsRegion: 'us-east-1',
        awsService: 'es',
      } as any);

      expect(key).toBe('sigv4|https://search-domain.us-east-1.es.amazonaws.com|us-east-1|default|es');
      expect(key.startsWith('basic|')).toBe(false);
    });

    it('throws on an unrecognized authType (consistent with createOpenSearchClient)', () => {
      expect(() => configToCacheKey({
        endpoint: 'https://x',
        authType: 'aws',
      } as any)).toThrow(/Invalid storage\/observability authType 'aws'/);
    });

    it('should generate none auth cache key', () => {
      const key = configToCacheKey({
        endpoint: 'https://localhost:9200',
        authType: 'none',
      });

      expect(key).toBe('none|https://localhost:9200');
    });

    it('should produce different keys for different configs', () => {
      const key1 = configToCacheKey({ endpoint: 'https://a.com', username: 'u1', password: 'p1' });
      const key2 = configToCacheKey({ endpoint: 'https://b.com', username: 'u1', password: 'p1' });
      const key3 = configToCacheKey({ endpoint: 'https://a.com', authType: 'sigv4', awsRegion: 'us-east-1' });

      expect(key1).not.toBe(key2); // different endpoints
      expect(key1).not.toBe(key3); // different auth types
      // Verify no plaintext password in basic key
      expect(key1).not.toContain('p1');
    });

    it('should produce same hash for same credentials, different hash for different credentials', () => {
      const key1 = configToCacheKey({ endpoint: 'https://a.com', username: 'user', password: 'pass1' });
      const key2 = configToCacheKey({ endpoint: 'https://a.com', username: 'user', password: 'pass1' });
      const key3 = configToCacheKey({ endpoint: 'https://a.com', username: 'user', password: 'pass2' });

      expect(key1).toBe(key2);
      expect(key1).not.toBe(key3);
    });
  });
});
