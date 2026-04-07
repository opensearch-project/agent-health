/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Factory for the coding agent registry singleton.
 * Separated from registry.ts to avoid circular imports with remoteAggregator.ts.
 *
 * Checks the feature toggle before creating a real registry. When disabled,
 * exports a lightweight stub that returns empty data for all methods.
 */

import { CodingAgentRegistry } from './registry';
import { RemoteAggregator } from './remoteAggregator';
import { getRemoteServers } from './remoteConfig';

/**
 * Check whether Coding Agent Analytics is enabled.
 * Disabled when:
 *   - env AGENT_HEALTH_DISABLE_CODING_ANALYTICS=true
 *   - config codingAgentAnalytics === false
 */
function isCodingAnalyticsEnabled(): boolean {
  if (process.env.AGENT_HEALTH_DISABLE_CODING_ANALYTICS === 'true') return false;

  // Check JSON config file (same file remoteConfig reads)
  try {
    const fs = require('fs');
    const path = require('path');
    const filePath = path.join(process.cwd(), 'agent-health.config.json');
    if (fs.existsSync(filePath)) {
      const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (config.codingAgentAnalytics === false) return false;
    }
  } catch { /* config not available — default enabled */ }

  return true;
}

export const codingAnalyticsEnabled = isCodingAnalyticsEnabled();

function createRegistry(): CodingAgentRegistry | null {
  if (!codingAnalyticsEnabled) {
    console.log('[CodingAgents] Feature disabled via toggle');
    return null;
  }

  const remotes = getRemoteServers();
  if (remotes.length > 0) {
    console.log(`[CodingAgents] Remote aggregation enabled: ${remotes.map(r => r.name).join(', ')}`);
    return new RemoteAggregator(remotes);
  }
  return new CodingAgentRegistry();
}

export const codingAgentRegistry = createRegistry();
