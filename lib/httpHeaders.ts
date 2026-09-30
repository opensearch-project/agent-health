/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Case-insensitive HTTP header helpers.
 *
 * HTTP header names are case-insensitive, but a plain `Record<string, string>`
 * is not: `{ 'Content-Type': 'a', 'content-type': 'b' }` holds two keys, and
 * undici (Node's `fetch`) folds them into ONE header whose value is
 * `"a, b"`. That is exactly how a SigV4-signed request breaks — the signer
 * emits lowercase `content-type`, the connector spreads a `Content-Type`
 * default on top, and the wire value no longer matches what was signed.
 */

/** Lowercase every header name. Later keys win on case-insensitive collisions. */
export function normalizeHeaderKeys(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

/** True when `headers` contains `name` under any casing. */
export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === wanted);
}

/**
 * `{ ...defaults, ...headers }` — but a default is only applied when
 * `headers` does not already carry that name under ANY casing, so a caller
 * that supplies `content-type` never ends up with a duplicate `Content-Type`.
 * The caller's own casing is preserved untouched.
 */
export function withDefaultHeaders(
  defaults: Record<string, string>,
  headers: Record<string, string> = {}
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(defaults)) {
    if (!hasHeader(headers, name)) out[name] = value;
  }
  return { ...out, ...headers };
}
