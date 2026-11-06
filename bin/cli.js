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
 *
 * This shim is deliberately plain JavaScript with only built-in imports: the
 * Node.js version guard below has to run BEFORE the bundled CLI (or tsx) is
 * loaded, so that an unsupported Node fails with one clear message instead of
 * whatever the bundle happens to trip over first.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import nodeVersionGuard from './nodeVersionGuard.cjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Refuse end-of-life / unpatched Node releases (CVE-2026-111497; `.ts` config
// needs built-in type stripping). `engines.node` in package.json is the single
// source of truth — npm only warns on it, this makes it binding.
const nodeVerdict = nodeVersionGuard.checkNodeVersion(
  process.versions.node,
  nodeVersionGuard.readEnginesRange(join(__dirname, '..', 'package.json'))
);

const cliSourcePath = join(__dirname, '..', 'cli', 'index.ts');
const isInNodeModules = import.meta.url.split('/').includes('node_modules');

// Development mode: TypeScript source exists and not running from node_modules
const isDev = existsSync(cliSourcePath) && !isInNodeModules;

if (!nodeVerdict.ok) {
  // Set the exit code and let the process end naturally so the message is
  // fully flushed even when stderr is a pipe (process.exit() can truncate it).
  process.exitCode = 1;
  process.stderr.write(nodeVerdict.message);
} else if (isDev) {
  // Import tsx to enable TypeScript execution, then run source
  await import('tsx/esm');
  await import('../cli/index.ts');
} else {
  // Production: use pre-built JavaScript
  await import('../cli/dist/index.js');
}
