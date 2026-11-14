/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `assistant` block of agent-health.config.ts → effective assistant settings,
 * and its passthrough from the config loader.
 */

import { resolve } from 'path';
import { resolveAskSettings, ASK_DEFAULT_MAX_CONCURRENT } from '@/server/services/ask/askService';

describe('resolveAskSettings', () => {
  const cwd = '/srv/agent-health';

  it('defaults: enabled, no model pin, .agent-health/ask-sessions under the cwd, 4 concurrent', () => {
    expect(resolveAskSettings({}, {}, cwd)).toEqual({
      enabled: true,
      model: undefined,
      sessionsDir: resolve(cwd, '.agent-health/ask-sessions'),
      maxConcurrent: ASK_DEFAULT_MAX_CONCURRENT,
      toolTimeoutMs: 30_000,
      turnTimeoutMs: 240_000,
      maxToolCalls: 30,
    });
  });

  it('reads the config block; relative sessionsDir resolves against the cwd, absolute stays', () => {
    expect(resolveAskSettings({ assistant: { enabled: false, model: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6', sessionsDir: 'var/ask', maxConcurrent: 2, toolTimeoutMs: 5000, turnTimeoutMs: 60_000, maxToolCalls: 5 } }, {}, cwd)).toEqual({
      enabled: false,
      model: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
      sessionsDir: resolve(cwd, 'var/ask'),
      maxConcurrent: 2,
      toolTimeoutMs: 5000,
      turnTimeoutMs: 60_000,
      maxToolCalls: 5,
    });
    expect(resolveAskSettings({ assistant: { sessionsDir: '/data/ask' } }, {}, cwd).sessionsDir).toBe('/data/ask');
    // budget env overrides win; nonsense values fall back to the defaults
    const budgets = resolveAskSettings({ assistant: { toolTimeoutMs: 5000 } }, { AH_ASK_TOOL_TIMEOUT_MS: '700', AH_ASK_TURN_TIMEOUT_MS: 'soon', AH_ASK_MAX_TOOL_CALLS: '-3' }, cwd);
    expect([budgets.toolTimeoutMs, budgets.turnTimeoutMs, budgets.maxToolCalls]).toEqual([700, 240_000, 30]);
  });

  it('env overrides win over the config block', () => {
    const s = resolveAskSettings({ assistant: { model: 'cfg-model', sessionsDir: 'cfg-dir' } }, { AH_ASK_MODEL_ID: 'env-model', AH_ASK_SESSIONS_DIR: '/env/dir' }, cwd);
    expect(s.model).toBe('env-model');
    expect(s.sessionsDir).toBe('/env/dir');
  });

  it('ignores a nonsensical maxConcurrent', () => {
    for (const bad of [0, -1, 1.5, NaN, 'four' as any]) {
      expect(resolveAskSettings({ assistant: { maxConcurrent: bad } }, {}, cwd).maxConcurrent).toBe(ASK_DEFAULT_MAX_CONCURRENT);
    }
  });
});

describe('config loader passes `assistant` through', () => {
  it('ResolvedConfig.assistant mirrors UserConfig.assistant', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = mkdtempSync(join(tmpdir(), 'ask-cfg-'));
    try {
      // CommonJS so the CJS test runtime can import() it; the loader accepts .js configs.
      writeFileSync(join(dir, 'agent-health.config.js'), "module.exports = { assistant: { enabled: true, model: 'pinned', maxConcurrent: 2 } };\n");
      const { loadConfig, clearConfigCache } = await import('@/lib/config/loader');
      clearConfigCache();
      const cfg = await loadConfig(dir);
      expect(cfg.assistant).toEqual({ enabled: true, model: 'pinned', maxConcurrent: 2 });
      clearConfigCache();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
