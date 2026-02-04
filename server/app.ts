/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Express App Factory
 * Creates and configures the Express application
 */

import express, { Express } from 'express';
import routes from './routes/index.js';
import { setupMiddleware } from './middleware/index.js';

// Register server-side connectors (subprocess, claude-code)
// This import has side effects that register connectors with the registry
import '@/services/connectors/server';

/**
 * Create and configure the Express application
 * @returns Configured Express app
 */
export function createApp(): Express {
  const app = express();

  // Setup middleware (CORS, JSON parsing, static serving)
  setupMiddleware(app);

  // Setup routes
  app.use(routes);

  return app;
}

export default createApp;
