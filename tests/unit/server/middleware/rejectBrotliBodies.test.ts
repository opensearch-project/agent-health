/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CVE-2026-111497 defence-in-depth: `rejectBrotliRequestBodies` must stop a
 * `Content-Encoding: br` request BEFORE body-parser pipes it through
 * `zlib.createBrotliDecompress()`, while gzip / deflate / identity bodies keep
 * flowing into the JSON parser exactly as before.
 *
 * The parser under test is the REAL express/body-parser (not a mock): the
 * first block documents the exposure this guard closes — without the guard,
 * body-parser really does inflate a brotli body on the server.
 */

import express, { Express, Request, Response } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import zlib from 'zlib';
import {
  rejectBrotliRequestBodies,
  namesBrotliEncoding,
  UNSUPPORTED_CONTENT_ENCODING_CODE,
} from '@/server/middleware/rejectBrotliBodies';

const PAYLOAD = { hello: 'world', n: 42 };
const JSON_BYTES = Buffer.from(JSON.stringify(PAYLOAD));

function buildApp(withGuard: boolean): Express {
  const app = express();
  if (withGuard) app.use(rejectBrotliRequestBodies);
  app.use(express.json({ limit: '1mb' }));
  app.post('/echo', (req: Request, res: Response) => {
    res.status(200).json({ received: req.body });
  });
  app.get('/plain', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });
  // Mirror the app's JSON error handler so body-parser failures stay JSON.
  app.use((err: any, _req: Request, res: Response, next: express.NextFunction) => {
    if (err && typeof err.status === 'number') {
      return res.status(err.status).json({ error: err.message, type: err.type });
    }
    next(err);
  });
  return app;
}

// Real HTTP over a listening socket (superagent would re-serialize a Buffer
// body as JSON when Content-Type is application/json, defeating the point).
const servers: Server[] = [];
function listen(app: Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function post(baseUrl: string, body: Buffer, encoding?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (encoding) headers['Content-Encoding'] = encoding;
  const res = await fetch(`${baseUrl}/echo`, { method: 'POST', headers, body });
  const text = await res.text();
  let json: any = undefined;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? '' }, body: json ?? {} , text };
}

describe('rejectBrotliRequestBodies (CVE-2026-111497)', () => {
  describe('exposure without the guard (real body-parser behaviour, not a mock)', () => {
    it('body-parser inflates a brotli-encoded JSON body when nothing stops it', async () => {
      const res = await post(await listen(buildApp(false)), zlib.brotliCompressSync(JSON_BYTES), 'br');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: PAYLOAD });
    });
  });

  describe('with the guard mounted before express.json()', () => {
    let app: string;
    beforeAll(async () => { app = await listen(buildApp(true)); });

    it('rejects Content-Encoding: br with 415 + stable error code and never parses the body', async () => {
      const res = await post(app, zlib.brotliCompressSync(JSON_BYTES), 'br');
      expect(res.status).toBe(415);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.code).toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);
      expect(res.body.error).toMatch(/Unsupported Content-Encoding: br/);
      expect(res.body.received).toBeUndefined();
    });

    it('rejects case-insensitively (BR) and inside a coding list (gzip, br)', async () => {
      const upper = await post(app, zlib.brotliCompressSync(JSON_BYTES), 'BR');
      expect(upper.status).toBe(415);
      expect(upper.body.code).toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);

      const list = await post(app, zlib.brotliCompressSync(zlib.gzipSync(JSON_BYTES)), 'gzip, br');
      expect(list.status).toBe(415);
      expect(list.body.code).toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);
    });

    it('rejects br even when the body is garbage (the decoder is never reached)', async () => {
      const res = await post(app, Buffer.from([0xff, 0xfe, 0x00, 0x13, 0x37]), 'br');
      expect(res.status).toBe(415);
      expect(res.body.code).toBe(UNSUPPORTED_CONTENT_ENCODING_CODE);
    });

    it('leaves gzip bodies to body-parser (decoded normally)', async () => {
      const res = await post(app, zlib.gzipSync(JSON_BYTES), 'gzip');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: PAYLOAD });
    });

    it('leaves deflate bodies to body-parser (decoded normally)', async () => {
      const res = await post(app, zlib.deflateSync(JSON_BYTES), 'deflate');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: PAYLOAD });
    });

    it('leaves uncompressed bodies (no header / identity) untouched', async () => {
      const plain = await post(app, JSON_BYTES);
      expect(plain.status).toBe(200);
      expect(plain.body).toEqual({ received: PAYLOAD });

      const identity = await post(app, JSON_BYTES, 'identity');
      expect(identity.status).toBe(200);
      expect(identity.body).toEqual({ received: PAYLOAD });
    });

    it('does not interfere with body-less requests', async () => {
      const res = await fetch(`${app}/plain`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    it('still lets body-parser 415 unknown encodings itself (unchanged behaviour)', async () => {
      // Use a coding no body-parser release knows: `zstd` used to be the
      // "unknown" example here, but body-parser 2.4.0 decodes it on Node
      // >= 22.15 (so raw JSON labelled zstd becomes a 400 decode error).
      const res = await post(app, JSON_BYTES, 'x-unknown-coding');
      expect(res.status).toBe(415);
      expect(res.body.type).toBe('encoding.unsupported');
      expect(res.body.code).toBeUndefined();
    });
  });

  describe('namesBrotliEncoding', () => {
    it.each([
      ['br', true],
      ['BR', true],
      [' br ', true],
      ['gzip, br', true],
      ['br,gzip', true],
      ['gzip', false],
      ['deflate', false],
      ['identity', false],
      ['brotli', false],
      ['', false],
      [undefined, false],
    ])('%p → %p', (value, expected) => {
      expect(namesBrotliEncoding(value as string | undefined)).toBe(expected);
    });

    it('handles a repeated header (array form)', () => {
      expect(namesBrotliEncoding(['gzip', 'br'])).toBe(true);
      expect(namesBrotliEncoding(['gzip', 'deflate'])).toBe(false);
    });
  });
});
