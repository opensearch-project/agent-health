/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Middleware Setup - CORS, JSON parsing, and static file serving
 */

import { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { debug } from '../../lib/debug.js';
import { storageClientMiddleware } from './storageClient.js';
import { apiKeyAuth } from './apiKeyAuth.js';

// Get directory of this file for resolving paths relative to package location
// Server always runs from server/dist/, so path resolution is straightforward
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Setup CORS middleware
 * - Same-origin only in both dev and production
 * - Dev mode uses Vite proxy (vite.config.ts) to forward /api requests
 */
function setupCors(app: Express): void {
  const isHeadless = process.env.AGENT_HEALTH_HEADLESS === '1';
  app.use(cors({
    // Headless mode: allow cross-origin (remote aggregator fetches from this server)
    // Normal mode: same-origin only (dev uses Vite proxy, prod serves from same server)
    origin: isHeadless ? true : false,
    credentials: true
  }));
}

/**
 * Setup JSON body parser
 */
function setupJsonParser(app: Express): void {
  app.use(express.json({ limit: '10mb' }));
}

/**
 * Setup static file serving for production mode
 * Serves built frontend assets (JS, CSS, images) from dist/ folder.
 * SPA fallback is registered separately via setupSpaFallback() after routes.
 */
function setupStaticServing(app: Express): void {
  // Headless mode: pure API server, no frontend assets
  if (process.env.AGENT_HEALTH_HEADLESS === '1') {
    debug('StaticServer', 'Headless mode — skipping static file serving');
    return;
  }

  // From server/dist/, go up 2 levels to package root, then into dist/
  const distPath = path.join(__dirname, '..', '..', 'dist');
  const indexPath = path.join(distPath, 'index.html');
  const indexExists = fs.existsSync(indexPath);

  debug('StaticServer', '__dirname:', __dirname);
  debug('StaticServer', 'Computed distPath:', distPath);
  debug('StaticServer', 'index.html exists:', indexExists);

  if (indexExists) {
    debug('StaticServer', 'Serving frontend from dist/ folder');
    app.use(express.static(distPath, {
      index: false,  // Don't serve index.html for directory requests — let SPA fallback handle it
    }));
  } else {
    debug('StaticServer', 'dist/index.html not found - API-only mode');
  }
}

/**
 * SPA fallback - serve index.html for all non-API routes.
 * Must be registered AFTER API routes so it only catches client-side routes.
 */
export function setupSpaFallback(app: Express): void {
  if (process.env.AGENT_HEALTH_HEADLESS === '1') return;

  const distPath = path.join(__dirname, '..', '..', 'dist');
  const indexPath = path.join(distPath, 'index.html');

  if (!fs.existsSync(indexPath)) return;

  // Read index.html once at startup — avoids sendFile issues in esbuild bundles
  const indexHtml = fs.readFileSync(indexPath, 'utf-8');

  app.use((req: Request, res: Response, next: NextFunction) => {
    // Skip API routes and health checks
    if (req.path.startsWith('/api/') || req.path === '/health') {
      return next();
    }
    // Only serve index.html for GET/HEAD requests (not OPTIONS, POST, etc.)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    res.type('html').send(indexHtml);
  });
}

/**
 * Setup storage client middleware
 * Attaches req.storageClient and req.storageConfig to each request
 */
function setupStorageClient(app: Express): void {
  app.use(storageClientMiddleware);
}

/**
 * Setup all middleware for the Express app
 */
export function setupMiddleware(app: Express): void {
  setupCors(app);
  setupJsonParser(app);
  app.use(apiKeyAuth);      // API key auth (no-op when AGENT_HEALTH_API_KEY not set)
  setupStorageClient(app);  // Add storage client before routes
  setupStaticServing(app);
}
