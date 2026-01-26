/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM equivalent of __dirname
const currentFilename = fileURLToPath(import.meta.url);
const currentDirname = path.dirname(currentFilename);

let cachedVersion: string | null = null;

/**
 * Find the package root by searching up from the current file location
 */
function findPackageRoot(): string {
  let dir = currentDirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback: from server/utils/ go up two levels
  return path.join(currentDirname, '..', '..');
}

export function getVersion(): string {
  if (cachedVersion !== null) {
    return cachedVersion;
  }

  try {
    const packageRoot = findPackageRoot();
    const packageJsonPath = path.join(packageRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    cachedVersion = packageJson.version || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }

  return cachedVersion;
}
