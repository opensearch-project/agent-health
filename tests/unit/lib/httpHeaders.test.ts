/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { hasHeader, normalizeHeaderKeys, withDefaultHeaders } from '@/lib/httpHeaders';

describe('lib/httpHeaders', () => {
  describe('normalizeHeaderKeys', () => {
    it('lowercases names and lets later keys win on case-insensitive collisions', () => {
      expect(normalizeHeaderKeys({ 'Content-Type': 'a', 'content-type': 'b', 'X-Api-Key': 'k' })).toEqual({
        'content-type': 'b',
        'x-api-key': 'k',
      });
    });

    it('drops undefined values', () => {
      expect(normalizeHeaderKeys({ A: 'x', B: undefined })).toEqual({ a: 'x' });
    });
  });

  describe('hasHeader', () => {
    it('matches any casing', () => {
      expect(hasHeader({ 'Content-Type': 'x' }, 'content-type')).toBe(true);
      expect(hasHeader({ 'content-type': 'x' }, 'CONTENT-TYPE')).toBe(true);
      expect(hasHeader({ accept: 'x' }, 'content-type')).toBe(false);
    });
  });

  describe('withDefaultHeaders', () => {
    it('applies a default only when the caller has no header of that name in any casing', () => {
      const out = withDefaultHeaders(
        { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        { 'content-type': 'application/json', authorization: 'AWS4-HMAC-SHA256 …' }
      );
      // exactly ONE content-type key (the caller's casing), Accept default kept
      expect(Object.keys(out).filter((k) => k.toLowerCase() === 'content-type')).toEqual(['content-type']);
      expect(out).toEqual({
        Accept: 'text/event-stream',
        'content-type': 'application/json',
        authorization: 'AWS4-HMAC-SHA256 …',
      });
    });

    it('is a plain spread when there is no overlap (back-compat with `{ ...defaults, ...headers }`)', () => {
      expect(withDefaultHeaders({ 'Content-Type': 'application/json' }, { Authorization: 'Bearer t' })).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer t',
      });
      expect(withDefaultHeaders({ 'Content-Type': 'application/json' })).toEqual({
        'Content-Type': 'application/json',
      });
    });
  });
});
