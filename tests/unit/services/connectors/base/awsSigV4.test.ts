/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { ConnectorAuth } from '@/services/connectors/types';

const mockFromNodeProviderChain = jest.fn();
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: (...args: unknown[]) => mockFromNodeProviderChain(...args),
}));

import {
  SigV4SigningError,
  clearSigV4ProviderCache,
  resolveSigV4CredentialProvider,
  signAwsSigV4Request,
} from '@/services/connectors/base/awsSigV4';

const STATIC: ConnectorAuth = {
  type: 'aws-sigv4',
  awsRegion: 'us-west-2',
  awsService: 'execute-api',
  awsAccessKeyId: 'AKIDEXAMPLE',
  awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const SIGNING_DATE = new Date('2026-01-02T03:04:05Z');
const URL_ = 'https://abc123.execute-api.us-west-2.amazonaws.com/prod/invoke?b=2&a=1&a=0';
const BODY = JSON.stringify({ prompt: 'hello', context: 'ctx' });

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function parseAuthorization(value: string) {
  const m = value.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/
  );
  if (!m) throw new Error(`unexpected Authorization header: ${value}`);
  const [, accessKeyId, date, region, service, signedHeaders, signature] = m;
  return { accessKeyId, date, region, service, signedHeaders: signedHeaders.split(';'), signature };
}

describe('signAwsSigV4Request', () => {
  const savedProfile = process.env.AWS_PROFILE;

  beforeEach(() => {
    clearSigV4ProviderCache();
    mockFromNodeProviderChain.mockReset();
    delete process.env.AWS_PROFILE;
  });

  afterAll(() => {
    if (savedProfile === undefined) delete process.env.AWS_PROFILE;
    else process.env.AWS_PROFILE = savedProfile;
  });

  it('signs with the configured service/region and hashes the exact body that will be sent', async () => {
    const { headers } = await signAwsSigV4Request({
      auth: STATIC,
      method: 'POST',
      url: URL_,
      body: BODY,
      headers: { 'Content-Type': 'application/json' },
      signingDate: SIGNING_DATE,
    });

    const authz = parseAuthorization(headers.authorization);
    expect(authz.accessKeyId).toBe('AKIDEXAMPLE');
    expect(authz.date).toBe('20260102');
    expect(authz.region).toBe('us-west-2');
    expect(authz.service).toBe('execute-api');
    expect(headers['x-amz-date']).toBe('20260102T030405Z');
    // payload hash is over the exact body string
    expect(headers['x-amz-content-sha256']).toBe(sha256Hex(BODY));
    expect(headers['x-amz-content-sha256']).not.toBe(sha256Hex(JSON.stringify({ prompt: 'hello' })));
    // host, content-type, x-amz-date and the payload hash are all signed
    expect(authz.signedHeaders).toEqual(
      expect.arrayContaining(['host', 'content-type', 'x-amz-date', 'x-amz-content-sha256'])
    );
    // no session token → no security-token header
    expect(headers['x-amz-security-token']).toBeUndefined();
  });

  it('produces a signature that an independent SignatureV4 (same creds, same request) reproduces', async () => {
    const { headers } = await signAwsSigV4Request({
      auth: STATIC,
      method: 'POST',
      url: URL_,
      body: BODY,
      headers: { 'Content-Type': 'application/json', 'x-custom': 'yes' },
      signingDate: SIGNING_DATE,
    });

    const verifier = new SignatureV4({
      credentials: { accessKeyId: STATIC.awsAccessKeyId!, secretAccessKey: STATIC.awsSecretAccessKey! },
      region: 'us-west-2',
      service: 'execute-api',
      sha256: Sha256,
    });
    const u = new URL(URL_);
    const expected = await verifier.sign(
      {
        method: 'POST',
        protocol: u.protocol,
        hostname: u.hostname,
        path: u.pathname,
        query: { b: '2', a: ['1', '0'] },
        headers: { host: u.host, 'content-type': 'application/json', 'x-custom': 'yes' },
        body: BODY,
      },
      { signingDate: SIGNING_DATE }
    );
    expect(headers.authorization).toBe(expected.headers.authorization);
    expect(parseAuthorization(headers.authorization).signedHeaders).toContain('x-custom');
  });

  it('lowercases header names so the transport sends ONE content-type (no `Content-Type, content-type` merge)', async () => {
    const { headers } = await signAwsSigV4Request({
      auth: STATIC,
      method: 'POST',
      url: URL_,
      body: BODY,
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k' },
      signingDate: SIGNING_DATE,
    });
    const keys = Object.keys(headers);
    expect(keys).toEqual(keys.map((k) => k.toLowerCase()));
    expect(keys.filter((k) => k.toLowerCase() === 'content-type')).toEqual(['content-type']);
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-api-key']).toBe('k');
  });

  it('signs `host` but does not return it (fetch sets it)', async () => {
    const { headers } = await signAwsSigV4Request({
      auth: STATIC,
      method: 'POST',
      url: 'https://example.com:8443/path',
      body: BODY,
      headers: {},
      signingDate: SIGNING_DATE,
    });
    expect(headers.host).toBeUndefined();
    expect(parseAuthorization(headers.authorization).signedHeaders).toContain('host');

    // …and the signed host includes the non-default port
    const verifier = new SignatureV4({
      credentials: { accessKeyId: STATIC.awsAccessKeyId!, secretAccessKey: STATIC.awsSecretAccessKey! },
      region: 'us-west-2',
      service: 'execute-api',
      sha256: Sha256,
    });
    const expected = await verifier.sign(
      {
        method: 'POST',
        protocol: 'https:',
        hostname: 'example.com',
        port: 8443,
        path: '/path',
        query: {},
        headers: { host: 'example.com:8443' },
        body: BODY,
      },
      { signingDate: SIGNING_DATE }
    );
    expect(headers.authorization).toBe(expected.headers.authorization);
  });

  it('adds and signs x-amz-security-token when a session token is configured', async () => {
    const { headers } = await signAwsSigV4Request({
      auth: { ...STATIC, awsSessionToken: 'SESSION-TOKEN' },
      method: 'POST',
      url: URL_,
      body: BODY,
      headers: {},
      signingDate: SIGNING_DATE,
    });
    expect(headers['x-amz-security-token']).toBe('SESSION-TOKEN');
    expect(parseAuthorization(headers.authorization).signedHeaders).toContain('x-amz-security-token');
  });

  it('a different body → different signature (the body is really covered)', async () => {
    const { headers: a } = await signAwsSigV4Request({ auth: STATIC, method: 'POST', url: URL_, body: BODY, headers: {}, signingDate: SIGNING_DATE });
    const { headers: b } = await signAwsSigV4Request({ auth: STATIC, method: 'POST', url: URL_, body: BODY + ' ', headers: {}, signingDate: SIGNING_DATE });
    expect(parseAuthorization(a.authorization).signature).not.toBe(parseAuthorization(b.authorization).signature);
  });

  describe('URL canonicalisation (wire bytes == signed bytes)', () => {
    const base = { auth: STATIC, method: 'POST', body: BODY, headers: {}, signingDate: SIGNING_DATE };

    async function expectedFor(url: string, query: Record<string, string | string[]>, headers: Record<string, string> = {}) {
      const u = new URL(url);
      const verifier = new SignatureV4({
        credentials: { accessKeyId: STATIC.awsAccessKeyId!, secretAccessKey: STATIC.awsSecretAccessKey! },
        region: 'us-west-2',
        service: 'execute-api',
        sha256: Sha256,
      });
      const signed = await verifier.sign(
        { method: 'POST', protocol: u.protocol, hostname: u.hostname, ...(u.port ? { port: Number(u.port) } : {}), path: u.pathname, query, headers: { host: u.host, ...headers }, body: BODY },
        { signingDate: SIGNING_DATE }
      );
      return signed.headers.authorization;
    }

    it('a literal `+` in a query value is NOT form-decoded to a space; wire and signature both carry %2B', async () => {
      const r = await signAwsSigV4Request({ ...base, url: 'https://example.com/p?q=1+2&plain=x' });
      expect(r.url).toBe('https://example.com/p?q=1%2B2&plain=x');
      expect(r.headers.authorization).toBe(await expectedFor(r.url, { q: '1+2', plain: 'x' }));
      // and NOT the form-decoded interpretation
      expect(r.headers.authorization).not.toBe(await expectedFor(r.url, { q: '1 2', plain: 'x' }));
    });

    it('%2B and %20 decode to literal plus / space and re-encode canonically; parameter order is preserved', async () => {
      const r = await signAwsSigV4Request({ ...base, url: 'https://example.com/p?z=a%2Bb&a=hello%20world&z=c%20d' });
      expect(r.url).toBe('https://example.com/p?z=a%2Bb&a=hello%20world&z=c%20d');
      expect(r.headers.authorization).toBe(await expectedFor(r.url, { z: ['a+b', 'c d'], a: 'hello world' }));
    });

    it('reserved characters that URLSearchParams would leave alone are RFC 3986-encoded on the wire', async () => {
      const r = await signAwsSigV4Request({ ...base, url: "https://example.com/p?f=a*b!c(d)'e&k=v/w:x" });
      expect(r.url).toBe('https://example.com/p?f=a%2Ab%21c%28d%29%27e&k=v%2Fw%3Ax');
      expect(r.headers.authorization).toBe(await expectedFor(r.url, { f: "a*b!c(d)'e", k: 'v/w:x' }));
    });

    it('a bare `?`, an empty parameter and a key without `=` are handled (`a` → `a=`)', async () => {
      expect((await signAwsSigV4Request({ ...base, url: 'https://example.com/p?' })).url).toBe('https://example.com/p');
      const r = await signAwsSigV4Request({ ...base, url: 'https://example.com/p?flag&&x=' });
      expect(r.url).toBe('https://example.com/p?flag=&x=');
      expect(r.headers.authorization).toBe(await expectedFor(r.url, { flag: '', x: '' }));
    });

    it('an encoded slash inside a path segment is kept as-is on the wire and double-encoded in the canonical URI', async () => {
      const r = await signAwsSigV4Request({ ...base, url: 'https://example.com/prod/items/a%2Fb/invoke' });
      expect(r.url).toBe('https://example.com/prod/items/a%2Fb/invoke');
      expect(r.headers.authorization).toBe(await expectedFor(r.url, {}));
    });

    it('IPv6 literal host with a non-default port: `host` is signed as `[::1]:8443`', async () => {
      const r = await signAwsSigV4Request({ ...base, url: 'https://[::1]:8443/p' });
      expect(r.url).toBe('https://[::1]:8443/p');
      expect(r.headers.host).toBeUndefined();
      expect(r.headers.authorization).toBe(await expectedFor('https://[::1]:8443/p', {}));
    });

    it('an explicit default port is dropped from host (fetch does the same)', async () => {
      const r = await signAwsSigV4Request({ ...base, url: 'https://example.com:443/p' });
      expect(r.url).toBe('https://example.com/p');
      expect(r.headers.authorization).toBe(await expectedFor('https://example.com/p', {}));
    });

    it('malformed percent-encoding in the query is a SigV4SigningError, not a crash', async () => {
      await expect(signAwsSigV4Request({ ...base, url: 'https://example.com/p?bad=%E0%A4%A' })).rejects.toThrow(
        /SigV4 signing failed: endpoint query string is not valid percent-encoding/
      );
    });

    it('a URL without a query is returned unchanged', async () => {
      const r = await signAwsSigV4Request({ ...base, url: URL_.split('?')[0] });
      expect(r.url).toBe(URL_.split('?')[0]);
    });
  });

  describe('reserved headers supplied by the caller are dropped, not signed', () => {
    it('x-amz-content-sha256 / x-amz-date / authorization / host / content-length from auth.headers do not leak into the signature', async () => {
      const r = await signAwsSigV4Request({
        auth: STATIC,
        method: 'POST',
        url: URL_,
        body: BODY,
        headers: {
          'X-Amz-Content-Sha256': 'deadbeef',
          'x-amz-date': '19990101T000000Z',
          Authorization: 'Bearer stale',
          Host: 'evil.example',
          'Content-Length': '1',
          'X-Keep': 'yes',
        },
        signingDate: SIGNING_DATE,
      });
      expect(r.headers['x-amz-content-sha256']).toBe(sha256Hex(BODY));
      expect(r.headers['x-amz-date']).toBe('20260102T030405Z');
      expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
      expect(r.headers.host).toBeUndefined();
      expect(r.headers['content-length']).toBeUndefined();
      expect(r.headers['x-keep']).toBe('yes');
      // identical to signing the same request without the junk
      const clean = await signAwsSigV4Request({ auth: STATIC, method: 'POST', url: URL_, body: BODY, headers: { 'X-Keep': 'yes' }, signingDate: SIGNING_DATE });
      expect(r.headers.authorization).toBe(clean.headers.authorization);
    });
  });

  describe('credential precedence', () => {
    it('explicit keys win — the provider chain is never consulted', async () => {
      await signAwsSigV4Request({ auth: STATIC, method: 'POST', url: URL_, body: BODY, headers: {}, signingDate: SIGNING_DATE });
      expect(mockFromNodeProviderChain).not.toHaveBeenCalled();
    });

    it('falls back to fromNodeProviderChain with auth.awsProfile and resolves credentials per request', async () => {
      const provider = jest
        .fn()
        .mockResolvedValueOnce({ accessKeyId: 'AKID-FIRST', secretAccessKey: 's1', sessionToken: 'tok1' })
        .mockResolvedValueOnce({ accessKeyId: 'AKID-ROTATED', secretAccessKey: 's2' });
      mockFromNodeProviderChain.mockReturnValue(provider);

      const auth: ConnectorAuth = { type: 'aws-sigv4', awsRegion: 'eu-west-1', awsService: 'lambda', awsProfile: 'eval' };
      const { headers: h1 } = await signAwsSigV4Request({ auth, method: 'POST', url: URL_, body: BODY, headers: {}, signingDate: SIGNING_DATE });
      const { headers: h2 } = await signAwsSigV4Request({ auth, method: 'POST', url: URL_, body: BODY, headers: {}, signingDate: SIGNING_DATE });

      expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(1); // provider memoised…
      expect(mockFromNodeProviderChain).toHaveBeenCalledWith(expect.objectContaining({ profile: 'eval', ignoreCache: true }));
      expect(provider).toHaveBeenCalledTimes(2); // …credentials resolved per request
      expect(parseAuthorization(h1.authorization).accessKeyId).toBe('AKID-FIRST');
      expect(h1['x-amz-security-token']).toBe('tok1');
      expect(parseAuthorization(h2.authorization).accessKeyId).toBe('AKID-ROTATED');
      expect(h2['x-amz-security-token']).toBeUndefined();
      expect(parseAuthorization(h1.authorization).region).toBe('eu-west-1');
      expect(parseAuthorization(h1.authorization).service).toBe('lambda');
    });

    it('uses $AWS_PROFILE when awsProfile is not set, and no profile at all otherwise', () => {
      mockFromNodeProviderChain.mockReturnValue(jest.fn());
      process.env.AWS_PROFILE = 'from-env';
      resolveSigV4CredentialProvider({ type: 'aws-sigv4', awsRegion: 'r', awsService: 's' });
      expect(mockFromNodeProviderChain).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'from-env' }));

      delete process.env.AWS_PROFILE;
      clearSigV4ProviderCache();
      resolveSigV4CredentialProvider({ type: 'aws-sigv4', awsRegion: 'r', awsService: 's' });
      expect(mockFromNodeProviderChain).toHaveBeenLastCalledWith(expect.not.objectContaining({ profile: expect.anything() }));
    });

    it('memoises one provider per profile', () => {
      mockFromNodeProviderChain.mockImplementation(() => jest.fn());
      const a1 = resolveSigV4CredentialProvider({ type: 'aws-sigv4', awsProfile: 'a' });
      const a2 = resolveSigV4CredentialProvider({ type: 'aws-sigv4', awsProfile: 'a' });
      const b = resolveSigV4CredentialProvider({ type: 'aws-sigv4', awsProfile: 'b' });
      expect(a1).toBe(a2);
      expect(b).not.toBe(a1);
      expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(2);
    });
  });

  describe('errors surface as SigV4SigningError with profile/region/service context', () => {
    const base = { method: 'POST', url: URL_, body: BODY, headers: {}, signingDate: SIGNING_DATE };

    it('missing region', async () => {
      await expect(
        signAwsSigV4Request({ ...base, auth: { type: 'aws-sigv4', awsService: 'execute-api', awsProfile: 'p' } })
      ).rejects.toThrow('SigV4 signing failed: auth.awsRegion is required (profile p / region <unset> / service execute-api)');
    });

    it('missing service', async () => {
      await expect(
        signAwsSigV4Request({ ...base, auth: { type: 'aws-sigv4', awsRegion: 'us-east-1' } })
      ).rejects.toThrow('SigV4 signing failed: auth.awsService is required (profile default / region us-east-1 / service <unset>)');
    });

    it('half-configured static credentials', async () => {
      await expect(
        signAwsSigV4Request({ ...base, auth: { ...STATIC, awsSecretAccessKey: undefined } })
      ).rejects.toThrow(/awsAccessKeyId and awsSecretAccessKey must be provided together/);
    });

    it('relative endpoint', async () => {
      await expect(signAwsSigV4Request({ ...base, auth: STATIC, url: '/relative' })).rejects.toThrow(
        /SigV4 signing failed: endpoint is not an absolute URL: \/relative/
      );
    });

    it('credential chain failure is wrapped, not leaked as a raw SDK error', async () => {
      mockFromNodeProviderChain.mockReturnValue(
        jest.fn().mockRejectedValue(new Error('Could not load credentials from any providers'))
      );
      const err = await signAwsSigV4Request({
        ...base,
        auth: { type: 'aws-sigv4', awsRegion: 'us-east-1', awsService: 'sts', awsProfile: 'missing-profile' },
      }).catch((e) => e);
      expect(err).toBeInstanceOf(SigV4SigningError);
      expect(err.message).toBe(
        'SigV4 signing failed: Could not load credentials from any providers (profile missing-profile / region us-east-1 / service sts)'
      );
      expect(err.cause).toBeInstanceOf(Error);
    });
  });
});
