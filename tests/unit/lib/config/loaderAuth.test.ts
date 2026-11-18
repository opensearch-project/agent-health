/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `auth` on a TS/JS-config agent must survive `toAgentConfig`.
 *
 * docs/CONNECTORS.md documents `auth: { type: 'aws-sigv4', … }` on an agent,
 * but the loader's UserAgentConfig → AgentConfig conversion listed every
 * field by hand and left `auth` out, so a sigv4 agent's requests went out
 * unsigned (403 Missing Authentication Token) while header-inferred auth
 * kept working. Real loader, real file — only the config content is a fixture.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('config loader — agent `auth` is carried onto the resolved AgentConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-loader-auth-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an explicit aws-sigv4 auth block verbatim', async () => {
    // CommonJS so the CJS test runtime can import() it; the loader accepts .js configs.
    writeFileSync(
      join(dir, 'agent-health.config.js'),
      `module.exports = { agents: [{
        key: 'gateway-agent', name: 'Agent behind API Gateway', connectorType: 'rest',
        endpoint: 'https://example.execute-api.us-west-2.amazonaws.com/prod/invoke',
        auth: { type: 'aws-sigv4', awsRegion: 'us-west-2', awsService: 'execute-api', awsProfile: 'eval' },
      }] };\n`,
    );
    const { loadConfig, clearConfigCache } = await import('@/lib/config/loader');
    clearConfigCache();
    try {
      const cfg = await loadConfig(dir, true);
      const agent = cfg.agents.find((a) => a.key === 'gateway-agent');
      expect(agent).toBeDefined();
      expect(agent!.auth).toEqual({ type: 'aws-sigv4', awsRegion: 'us-west-2', awsService: 'execute-api', awsProfile: 'eval' });
    } finally {
      clearConfigCache();
    }
  });

  it('leaves `auth` undefined when the agent declares none (header inference unchanged)', async () => {
    writeFileSync(
      join(dir, 'agent-health.config.js'),
      `module.exports = { agents: [{ key: 'plain', name: 'Plain', connectorType: 'rest',
        endpoint: 'http://127.0.0.1:1/ask', headers: { Authorization: 'Bearer t' } }] };\n`,
    );
    const { loadConfig, clearConfigCache } = await import('@/lib/config/loader');
    clearConfigCache();
    try {
      const cfg = await loadConfig(dir, true);
      const agent = cfg.agents.find((a) => a.key === 'plain')!;
      expect(agent.auth).toBeUndefined();
      expect(agent.headers).toEqual({ Authorization: 'Bearer t' });
    } finally {
      clearConfigCache();
    }
  });
});
