#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CLI Entry Point
 *
 * In development: Runs TypeScript source directly via tsx (instant changes)
 * In production: Runs pre-built JavaScript from cli/dist/
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliSourcePath = join(__dirname, '..', 'cli', 'index.ts');
const isInNodeModules = import.meta.url.split('/').includes('node_modules');

// Development mode: TypeScript source exists and not running from node_modules
const isDev = existsSync(cliSourcePath) && !isInNodeModules;

if (isDev) {
  // Import tsx to enable TypeScript execution, then run source
  await import('tsx/esm');
  await import('../cli/index.ts');
} else {
  // Production: use pre-built JavaScript
  await import('../cli/dist/index.js');
}
