/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { CodingAgentRegistry } from './registry';

export type {
  AgentKind,
  AgentSession,
  AgentStats,
  CombinedStats,
  CostAnalytics,
  ActivityData,
  ToolsAnalytics,
  ToolSummary,
  DailyActivity,
  DailyCost,
  DateRange,
  EfficiencyAnalytics,
  Insight,
  CodingAgentReader,
  SessionDetail,
  SessionMessage,
  ProjectAnalytics,
  McpAnalytics,
  McpServerSummary,
  AdvancedAnalytics,
  HourlyEffectiveness,
  DurationBucket,
  ConversationDepthStats,
  FailurePattern,
  ExportData,
} from './types';

/**
 * Check whether Coding Agent Analytics is enabled.
 * Disabled when env AGENT_HEALTH_DISABLE_CODING_ANALYTICS=true
 * or config codingAgentAnalytics === false.
 */
function isCodingAnalyticsEnabled(): boolean {
  if (process.env.AGENT_HEALTH_DISABLE_CODING_ANALYTICS === 'true') return false;

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
  return new CodingAgentRegistry();
}

export const codingAgentRegistry = createRegistry();
