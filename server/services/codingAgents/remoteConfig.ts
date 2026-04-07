/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remote server configuration reader.
 * Reads remoteServers from agent-health.config.json.
 */

import fs from 'fs';
import path from 'path';
import type { RemoteServerConfig } from '@/lib/config/types';

const CONFIG_FILENAME = 'agent-health.config.json';

export function getRemoteServers(): RemoteServerConfig[] {
  try {
    const filePath = path.join(process.cwd(), CONFIG_FILENAME);
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);
    if (Array.isArray(config.remoteServers)) {
      return config.remoteServers.filter(
        (s: unknown): s is RemoteServerConfig =>
          typeof s === 'object' && s !== null &&
          typeof (s as RemoteServerConfig).name === 'string' &&
          typeof (s as RemoteServerConfig).url === 'string'
      );
    }
  } catch { /* config not available */ }
  return [];
}
