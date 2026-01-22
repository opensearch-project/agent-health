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
import { storageClientMiddleware } from './storageClient.js';

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
  app.use(cors({
    origin: false,  // Same-origin only - dev uses Vite proxy, prod serves from same server
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
 * Serves built frontend from dist/ folder
 */
function setupStaticServing(app: Express): void {
  // From server/dist/, go up 2 levels to package root, then into dist/
  const distPath = path.join(__dirname, '..', '..', 'dist');
  const distExists = fs.existsSync(distPath);

  // Debug logging to diagnose path resolution
  console.log('[StaticServer] __dirname:', __dirname);
  console.log('[StaticServer] Computed distPath:', distPath);
  console.log('[StaticServer] distPath exists:', distExists);

  if (distExists) {
    console.log('[StaticServer] Serving frontend from dist/ folder');
    console.log('[StaticServer] Dist path:', distPath);

    // Serve static assets (JS, CSS, images, etc.)
    app.use(express.static(distPath));

    // SPA fallback - serve index.html for all non-API routes
    app.use((req: Request, res: Response, next: NextFunction) => {
      // Don't serve index.html for API routes or if file exists
      if (req.path.startsWith('/api/') || req.path === '/health') {
        return next();
      }
      const indexPath = path.join(distPath, 'index.html');
      res.sendFile(indexPath);
    });
  } else {
    console.log('[StaticServer] dist/ folder not found - running in API-only mode');
    console.log('[StaticServer] Run "npm run build" to generate the frontend build');
  }
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
  setupStorageClient(app);  // Add storage client before routes
  setupStaticServing(app);
}
