/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SPA fallback middleware factory.
 *
 * Lives in its own module so unit tests can import it without dragging in
 * `server/middleware/index.ts`'s top-level `import.meta.url` (which breaks
 * under ts-jest's CJS transform).
 *
 * Asset paths (anything under /assets/, /static/, or with a typical web-asset
 * extension) are explicitly *not* served as the SPA shell. If
 * `express.static` already handled the asset, this middleware never sees it;
 * if not, returning index.html (text/html) for an asset request produces:
 *
 *   "Failed to load module script: Expected a JavaScript-or-Wasm module
 *    script but the server responded with a MIME type of \"text/html\".
 *    Strict MIME type checking is enforced for module scripts per HTML
 *    spec."
 *
 * which leaves the user with a blank page after every deploy whenever their
 * browser cached an `index.html` that points at a now-replaced asset hash.
 */

import type { Request, Response, NextFunction } from 'express';

// Anything ending in a typical web-asset extension is treated as a static
// asset request, not a client-side route. If express.static didn't already
// serve it, it doesn't exist — return 404, never index.html.
export const ASSET_EXT_RE =
  /\.(?:js|mjs|cjs|css|map|json|wasm|ico|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|txt|xml|pdf)$/i;

/**
 * Pure SPA-fallback middleware factory. Pass the preloaded `index.html`
 * body and you get back a request handler that:
 *   - passes /api/* and /health through untouched
 *   - 404s for anything under /assets/ or /static/
 *   - 404s for any path that ends in a known asset extension
 *   - 404s for non-GET/HEAD methods (lets Express's default 404 handle them)
 *   - serves index.html (text/html) for everything else (real client-side routes)
 */
export function makeSpaFallbackMiddleware(indexHtml: string) {
  return function spaFallback(req: Request, res: Response, next: NextFunction) {
    if (req.path.startsWith('/api/') || req.path === '/health') {
      return next();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    if (req.path.startsWith('/assets/') || req.path.startsWith('/static/')) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    if (ASSET_EXT_RE.test(req.path)) {
      return res.status(404).type('text/plain').send('Not Found');
    }
    res.type('html').send(indexHtml);
  };
}
