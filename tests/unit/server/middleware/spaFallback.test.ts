/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the SPA fallback middleware factory.
 *
 * Regression coverage for the production white-screen bug:
 *
 *   "Failed to load module script: Expected a JavaScript-or-Wasm module
 *    script but the server responded with a MIME type of \"text/html\"."
 *
 * Cause: a stale cached `index.html` references `/assets/index-OLDHASH.js`,
 * the asset no longer exists, the SPA fallback used to return `index.html`
 * (text/html) for ANY non-/api path, and strict MIME enforcement in
 * browsers refuses to execute it as a module — leaving the user with a
 * blank page after every deploy.
 *
 * The fallback now returns 404 for any path under `/assets/` or `/static/`
 * and for any path with a typical web-asset extension. Real client-side
 * routes (extension-less paths like `/evaluations/...`) still receive the
 * SPA index.html.
 *
 * The middleware factory is in `server/middleware/spaFallback.ts` so this
 * test file can import it without dragging `server/middleware/index.ts`'s
 * top-level `import.meta.url` into ts-jest's CJS transform.
 */

import express, { Express } from 'express';
import http from 'http';
import { makeSpaFallbackMiddleware, ASSET_EXT_RE } from '@/server/middleware/spaFallback';

const FAKE_INDEX_HTML =
  '<!doctype html><html><head><title>app</title></head><body><div id="root"></div></body></html>';

interface ProbeResult {
  status: number;
  contentType: string;
  body: string;
}

function probe(app: Express, urlPath: string, method = 'GET'): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        return reject(new Error('no address'));
      }
      const req = http.request(
        { host: '127.0.0.1', port: addr.port, path: urlPath, method },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            resolve({
              status: res.statusCode || 0,
              contentType: String(res.headers['content-type'] || ''),
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

function buildApp(): Express {
  const app = express();
  // Real API routes registered ahead of the fallback to verify the fallback
  // doesn't shadow them.
  app.get('/api/storage/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(makeSpaFallbackMiddleware(FAKE_INDEX_HTML));
  return app;
}

describe('makeSpaFallbackMiddleware', () => {
  let app: Express;
  beforeAll(() => { app = buildApp(); });

  it('serves index.html (text/html) for the root path', async () => {
    const r = await probe(app, '/');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toContain('<div id="root">');
  });

  it('serves index.html for client-side routes without extensions', async () => {
    const r = await probe(app, '/evaluations/benchmarks/foo/runs/bar/inspect');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
    expect(r.body).toContain('<div id="root">');
  });

  it('returns 404 (NOT html) for missing /assets/ JS bundles — the regression', async () => {
    // The exact bug shape: stale cached index.html requests an old hash.
    // Pre-fix this returned 200 with text/html, triggering strict-MIME
    // refusal in the browser and a blank page.
    const r = await probe(app, '/assets/index-OLDHASH.js');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
    expect(r.body).not.toContain('<html');
  });

  it('returns 404 (NOT html) for missing /assets/ CSS bundles', async () => {
    const r = await probe(app, '/assets/index-OLDHASH.css');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it('returns 404 (NOT html) for missing /assets/ source map', async () => {
    const r = await probe(app, '/assets/index-OLDHASH.js.map');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it('returns 404 (NOT html) for missing /static/ assets', async () => {
    const r = await probe(app, '/static/foo.js');
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it.each([
    '/missing.js',
    '/missing.mjs',
    '/missing.css',
    '/missing.map',
    '/missing.json',
    '/missing.png',
    '/missing.svg',
    '/missing.woff2',
    '/missing.wasm',
    '/favicon.ico',
  ])('returns 404 for missing path with asset extension: %s', async (p) => {
    const r = await probe(app, p);
    expect(r.status).toBe(404);
    expect(r.contentType).not.toMatch(/text\/html/);
  });

  it('does NOT intercept /api/* routes', async () => {
    const r = await probe(app, '/api/storage/health');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/application\/json/);
    expect(JSON.parse(r.body)).toEqual({ status: 'ok' });
  });

  it('does NOT intercept /health', async () => {
    const r = await probe(app, '/health');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/application\/json/);
  });

  it('returns index.html for paths without a dot (real client-side route)', async () => {
    const r = await probe(app, '/evaluations/benchmarks');
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/text\/html/);
  });

  it('falls through (does not return SPA shell) for non-GET methods', async () => {
    // POST /assets/foo.js should not return index.html. With no POST route
    // registered, Express's default 404 handler kicks in.
    const r = await probe(app, '/assets/foo.js', 'POST');
    expect(r.status).toBe(404);
    // Default Express 404 is text/html "Cannot POST /assets/foo.js" — we just
    // assert it's NOT the SPA shell (which contains '<div id="root">').
    expect(r.body).not.toContain('<div id="root">');
  });
});

describe('ASSET_EXT_RE', () => {
  it('matches all common web asset extensions (case-insensitive)', () => {
    const cases = [
      'foo.js', 'foo.mjs', 'foo.cjs', 'foo.css', 'foo.json', 'foo.map',
      'foo.wasm', 'foo.ico', 'foo.png', 'foo.JPG', 'foo.svg', 'foo.WOFF2',
      'foo.ttf', 'foo.otf', 'foo.mp4', 'foo.webm', 'foo.txt', 'foo.pdf',
    ];
    for (const c of cases) expect(ASSET_EXT_RE.test(c)).toBe(true);
  });

  it('does not match plain client-side route segments', () => {
    expect(ASSET_EXT_RE.test('/evaluations/benchmarks')).toBe(false);
    expect(ASSET_EXT_RE.test('/run-1234-abc')).toBe(false);
    expect(ASSET_EXT_RE.test('/')).toBe(false);
  });
});
