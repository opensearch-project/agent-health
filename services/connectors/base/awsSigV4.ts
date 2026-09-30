/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AWS Signature Version 4 signing for HTTP connectors (`auth.type: 'aws-sigv4'`).
 *
 * Signs the ACTUAL outgoing request — method, full URL (path + query), the
 * exact body string that will be sent and the exact header map that will be
 * sent — so AWS-fronted endpoints (API Gateway `execute-api`, Lambda function
 * URLs `lambda`, Bedrock AgentCore, App Runner, ALB+IAM, …) accept it.
 *
 * Credential precedence:
 *   1. explicit `awsAccessKeyId` / `awsSecretAccessKey` (+ `awsSessionToken`)
 *   2. the AWS default credential provider chain
 *      (`fromNodeProviderChain({ profile: awsProfile ?? $AWS_PROFILE })`:
 *      env vars → shared ini profile / SSO → process → web identity →
 *      container / instance metadata).
 *
 * The provider is memoised per profile; the credentials it yields are NOT —
 * the chain re-resolves whenever the cached credentials expire, so rotated
 * profile / STS credentials are picked up without a restart.
 */

import { SignatureV4, type SignatureV4Init } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { ConnectorAuth } from '@/services/connectors/types';
import { normalizeHeaderKeys } from '@/lib/httpHeaders';

/** Thrown for every failure between "we need a signature" and "we have one". */
export class SigV4SigningError extends Error {
  readonly cause?: unknown;
  constructor(
    reason: string,
    scope: { profile?: string; region?: string; service?: string },
    cause?: unknown
  ) {
    super(
      `SigV4 signing failed: ${reason} ` +
        `(profile ${scope.profile ?? 'default'} / region ${scope.region ?? '<unset>'} / service ${scope.service ?? '<unset>'})`
    );
    this.name = 'SigV4SigningError';
    this.cause = cause;
  }
}

export interface SigV4SignInput {
  auth: ConnectorAuth;
  method: string;
  /** Absolute URL, exactly what will be passed to `fetch`. */
  url: string;
  /** Exact body string that will be sent (`JSON.stringify(payload)`); omit for bodiless requests. */
  body?: string;
  /** Every header the transport will send (defaults + auth + custom), any casing. */
  headers: Record<string, string>;
  /** Injected for tests; defaults to `new Date()`. */
  signingDate?: Date;
}

export interface SigV4SignedRequest {
  /**
   * The URL to fetch. Same scheme/host/path and the same query parameters in
   * the same order as the input, but with the query percent-encoded in the
   * RFC 3986 form the signature was computed over — so the bytes on the wire
   * and the canonical request cannot disagree on `+` / `%2B` / `%20`.
   */
  url: string;
  /** Full header map to send (lowercase names, `host` omitted). */
  headers: Record<string, string>;
}

/**
 * Headers the caller may not supply for a signed request: they are produced
 * by the signer or by the transport, and a stale/foreign value would either
 * be signed and then overwritten on the wire (→ SignatureDoesNotMatch) or
 * would hijack the payload hash (`x-amz-content-sha256`).
 */
const RESERVED_REQUEST_HEADERS = new Set([
  'authorization',
  'host',
  'content-length',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-security-token',
]);

const PROVIDER_CACHE_KEY_DEFAULT = '\u0000default';
type CredentialProvider = Extract<SignatureV4Init['credentials'], (...args: any[]) => any>;
const providerCache = new Map<string, CredentialProvider>();

/** Test hook: forget memoised provider chains. */
export function clearSigV4ProviderCache(): void {
  providerCache.clear();
}

function resolveProfile(auth: ConnectorAuth): string | undefined {
  return auth.awsProfile || process.env.AWS_PROFILE || undefined;
}

/**
 * Pick the credential source for this auth block. Explicit static keys win;
 * otherwise the (memoised) Node provider chain for the requested profile.
 */
export function resolveSigV4CredentialProvider(auth: ConnectorAuth): CredentialProvider {
  if (auth.awsAccessKeyId || auth.awsSecretAccessKey) {
    if (!auth.awsAccessKeyId || !auth.awsSecretAccessKey) {
      throw new SigV4SigningError(
        'awsAccessKeyId and awsSecretAccessKey must be provided together',
        { profile: resolveProfile(auth), region: auth.awsRegion, service: auth.awsService }
      );
    }
    const identity = {
      accessKeyId: auth.awsAccessKeyId,
      secretAccessKey: auth.awsSecretAccessKey,
      ...(auth.awsSessionToken ? { sessionToken: auth.awsSessionToken } : {}),
    };
    return async () => identity;
  }

  const profile = resolveProfile(auth);
  const key = profile ?? PROVIDER_CACHE_KEY_DEFAULT;
  let provider = providerCache.get(key);
  if (!provider) {
    provider = fromNodeProviderChain({
      ...(profile ? { profile } : {}),
      // Re-read ~/.aws/credentials on every (re)resolution so rotated
      // profile credentials are picked up without a process restart
      // (same reasoning as server/services/opensearchClientFactory.ts).
      ignoreCache: true,
    });
    providerCache.set(key, provider);
  }
  return provider;
}

/** RFC 3986 unreserved-only percent-encoding — the same escaping SigV4 canonicalisation uses. */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Parse the RAW query string into ordered `[key, value]` pairs.
 *
 * Deliberately not `URLSearchParams`: that applies form-encoding rules
 * (`+` → space) which AWS does not, so a value like `a=1+2` would be signed
 * as `1 2`. Here each part is only percent-DEcoded, so `+` stays a literal
 * plus and `%2B` decodes to a literal plus as well — both are then
 * re-encoded as `%2B` on the wire and in the canonical request.
 */
function parseRawQuery(search: string): Array<[string, string]> {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return [];
  return raw
    .split('&')
    .filter((part) => part.length > 0)
    .map((part) => {
      const eq = part.indexOf('=');
      const k = eq === -1 ? part : part.slice(0, eq);
      const v = eq === -1 ? '' : part.slice(eq + 1);
      return [decodeURIComponent(k), decodeURIComponent(v)] as [string, string];
    });
}

/** `{ key: value | value[] }` — the shape `@smithy/signature-v4` canonicalises. */
function toQueryBag(pairs: Array<[string, string]>): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of pairs) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}

/**
 * Sign an outgoing request and return the URL to fetch plus the FULL header
 * map to send.
 *
 * - Header names are lowercased first so the signer and the transport agree
 *   on one key per header (no `Content-Type` + `content-type` pair); caller
 *   values for signer/transport-owned headers (RESERVED_REQUEST_HEADERS) are
 *   dropped rather than signed.
 * - The query string is parsed from the raw URL (no form-decoding) and
 *   re-serialised in canonical RFC 3986 form for the wire, see
 *   `SigV4SignedRequest.url`.
 * - `host` is signed (required by SigV4) but REMOVED from the returned map:
 *   `fetch` sets it itself and rejects/ignores a caller-supplied one.
 * - Adds `authorization`, `x-amz-date`, `x-amz-content-sha256` (payload hash
 *   of the exact `body`) and `x-amz-security-token` when the credentials
 *   carry a session token — all of them in `SignedHeaders`.
 * - Every header in `input.headers` (except SigV4's always-unsignable set such
 *   as `user-agent`) is part of `SignedHeaders`, so callers must pass the map
 *   they will send and must not alter those headers afterwards. Headers added
 *   AFTER signing (e.g. `traceparent`) are fine as long as they stay out of
 *   `SignedHeaders`.
 */
export async function signAwsSigV4Request(input: SigV4SignInput): Promise<SigV4SignedRequest> {
  const { auth } = input;
  const scope = { profile: resolveProfile(auth), region: auth.awsRegion, service: auth.awsService };

  if (!auth.awsRegion) throw new SigV4SigningError('auth.awsRegion is required', scope);
  if (!auth.awsService) throw new SigV4SigningError('auth.awsService is required', scope);

  let url: URL;
  try {
    url = new URL(input.url);
  } catch (err) {
    throw new SigV4SigningError(`endpoint is not an absolute URL: ${input.url}`, scope, err);
  }

  let queryPairs: Array<[string, string]>;
  try {
    queryPairs = parseRawQuery(url.search);
  } catch (err) {
    throw new SigV4SigningError(`endpoint query string is not valid percent-encoding: ${url.search}`, scope, err);
  }
  const wireQuery = queryPairs.map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`).join('&');
  const wireUrl = `${url.protocol}//${url.host}${url.pathname}${wireQuery ? `?${wireQuery}` : ''}`;

  const headers = normalizeHeaderKeys(input.headers);
  for (const name of RESERVED_REQUEST_HEADERS) delete headers[name];
  headers.host = url.host;

  let credentials: CredentialProvider;
  try {
    credentials = resolveSigV4CredentialProvider(auth);
  } catch (err) {
    if (err instanceof SigV4SigningError) throw err;
    throw new SigV4SigningError(err instanceof Error ? err.message : String(err), scope, err);
  }

  const signer = new SignatureV4({
    credentials,
    region: auth.awsRegion,
    service: auth.awsService,
    sha256: Sha256,
  });

  try {
    const signed = await signer.sign(
      {
        method: input.method.toUpperCase(),
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname,
        query: toQueryBag(queryPairs),
        headers,
        body: input.body,
      },
      input.signingDate ? { signingDate: input.signingDate } : undefined
    );
    const out = normalizeHeaderKeys(signed.headers as Record<string, string>);
    delete out.host;
    return { url: wireUrl, headers: out };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new SigV4SigningError(reason, scope, err);
  }
}
