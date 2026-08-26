/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_PRICING, DEFAULT_CONFIG, MOCK_TOOLS, isBuiltInAgent } from '@/lib/constants';

describe('lib/constants', () => {
  describe('isBuiltInAgent', () => {
    it('trusts the server-computed builtIn flag when present', () => {
      expect(isBuiltInAgent({ key: 'demo', builtIn: true })).toBe(true);
      // Config-file agent with a non-built-in key — the original Settings bug
      expect(isBuiltInAgent({ key: 'kiro', builtIn: false })).toBe(false);
      expect(isBuiltInAgent({ key: 'aos-oncall-cc', builtIn: false })).toBe(false);
    });

    it('falls back to BUILT_IN_AGENT_KEYS before refreshConfig() populates builtIn', () => {
      expect(isBuiltInAgent({ key: 'demo' })).toBe(true);
      expect(isBuiltInAgent({ key: 'observio' })).toBe(true);
      expect(isBuiltInAgent({ key: 'my-config-agent' })).toBe(false);
    });

    it('never treats UI-added custom agents as built-in', () => {
      expect(isBuiltInAgent({ key: 'demo', builtIn: true, isCustom: true })).toBe(false);
      expect(isBuiltInAgent({ key: 'custom-1', isCustom: true })).toBe(false);
    });

    it('every shipped DEFAULT_CONFIG agent is registered as built-in (drift guard)', () => {
      // A default agent missing from BUILT_IN_AGENT_KEYS gets builtIn: false
      // from /api/agents and would render under "Config File Agents"
      // (this happened to `pi`).
      for (const agent of DEFAULT_CONFIG.agents) {
        expect({ key: agent.key, builtIn: isBuiltInAgent(agent) })
          .toEqual({ key: agent.key, builtIn: true });
      }
    });
  });

  describe('MODEL_PRICING', () => {
    it('should have Claude Opus 4.6 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-opus-4-6-v1']).toEqual({
        input: 5.0,
        output: 25.0,
      });
    });

    it('should have Claude Sonnet 4.6 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-sonnet-4-6']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have Claude Haiku 4.5 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-haiku-4-5-20251001-v1:0']).toEqual({
        input: 1.0,
        output: 5.0,
      });
    });

    it('should have Claude Opus 4.5 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-opus-4-5-20251101-v1:0']).toEqual({
        input: 5.0,
        output: 25.0,
      });
    });

    it('should have Claude Opus 4.1 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-opus-4-1-20250805-v1:0']).toEqual({
        input: 15.0,
        output: 75.0,
      });
    });

    it('should have Claude Opus 4 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-opus-4-20250514-v1:0']).toEqual({
        input: 15.0,
        output: 75.0,
      });
    });

    it('should have Claude Sonnet 4 model pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-sonnet-4-20250514-v1:0']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have Claude Sonnet 4.5 model pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-sonnet-4-5-20250929-v1:0']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have Claude Haiku 3.5 pricing', () => {
      expect(MODEL_PRICING['us.anthropic.claude-3-5-haiku-20241022-v1:0']).toEqual({
        input: 0.80,
        output: 4.0,
      });
    });

    it('should have default fallback', () => {
      expect(MODEL_PRICING['default']).toEqual({
        input: 3.0,
        output: 15.0,
      });
    });

    it('should have all required pricing fields', () => {
      Object.entries(MODEL_PRICING).forEach(([key, pricing]) => {
        expect(pricing.input).toBeGreaterThanOrEqual(0);
        expect(pricing.output).toBeGreaterThanOrEqual(0);
        expect(typeof pricing.input).toBe('number');
        expect(typeof pricing.output).toBe('number');
      });
    });
  });

  describe('DEFAULT_CONFIG', () => {
    describe('agents', () => {
      it('should have at least one agent configured', () => {
        expect(DEFAULT_CONFIG.agents.length).toBeGreaterThan(0);
      });

      it('should have claude-code agent', () => {
        const claudeCode = DEFAULT_CONFIG.agents.find(a => a.key === 'claude-code');
        expect(claudeCode).toBeDefined();
        expect(claudeCode?.name).toBe('Claude Code');
        expect(claudeCode?.connectorType).toBe('claude-code');
      });

      it('should have valid agent structure', () => {
        DEFAULT_CONFIG.agents.forEach(agent => {
          expect(agent.key).toBeDefined();
          expect(agent.name).toBeDefined();
          expect(agent.endpoint).toBeDefined();
          expect(typeof agent.useTraces).toBe('boolean');
        });
      });
    });

    describe('models', () => {
      it('should have multiple models configured', () => {
        expect(Object.keys(DEFAULT_CONFIG.models).length).toBeGreaterThan(0);
      });

      it('should have claude-opus-4.6 model', () => {
        const model = DEFAULT_CONFIG.models['claude-opus-4.6'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-opus-4-6-v1');
        expect(model.display_name).toBe('Claude Opus 4.6');
        expect(model.context_window).toBe(200000);
        expect(model.max_output_tokens).toBe(128000);
        expect(model.provider).toBe('bedrock');
      });

      it('should have claude-sonnet-4.6 model', () => {
        const model = DEFAULT_CONFIG.models['claude-sonnet-4.6'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-sonnet-4-6');
        expect(model.display_name).toBe('Claude Sonnet 4.6');
        expect(model.max_output_tokens).toBe(64000);
      });

      it('should have claude-haiku-4.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-haiku-4.5'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
        expect(model.display_name).toBe('Claude Haiku 4.5');
        expect(model.max_output_tokens).toBe(64000);
      });

      it('should have claude-opus-4.8 model', () => {
        const model = DEFAULT_CONFIG.models['claude-opus-4.8'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-opus-4-8');
        expect(model.display_name).toBe('Claude Opus 4.8');
        expect(model.max_output_tokens).toBe(128000);
      });

      it('should have claude-opus-4.7 model', () => {
        const model = DEFAULT_CONFIG.models['claude-opus-4.7'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-opus-4-7');
        expect(model.display_name).toBe('Claude Opus 4.7');
        expect(model.max_output_tokens).toBe(128000);
      });

      it('should have claude-sonnet-4.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-sonnet-4.5'];
        expect(model).toBeDefined();
        expect(model.display_name).toBe('Claude Sonnet 4.5');
      });

      // Note: claude-opus-4.5 / 4.1 / 4, claude-sonnet-4, and claude-haiku-3.5
      // were removed from the default catalog (trimmed list — newest tiers
      // only). Discovery still surfaces any Bedrock model the account has
      // access to via /api/judge/bedrock-models; the static catalog just
      // seeds the dropdown with current models.

      it('should have valid model structure', () => {
        Object.entries(DEFAULT_CONFIG.models).forEach(([key, model]) => {
          expect(model.model_id).toBeDefined();
          expect(model.display_name).toBeDefined();
          expect(model.context_window).toBeGreaterThan(0);
          expect(model.max_output_tokens).toBeGreaterThan(0);
        });
      });
    });

    describe('defaults', () => {
      it('should have retry configuration', () => {
        expect(DEFAULT_CONFIG.defaults.retry_attempts).toBe(2);
        expect(DEFAULT_CONFIG.defaults.retry_delay_ms).toBe(1000);
      });
    });
  });

  describe('MOCK_TOOLS', () => {
    it('should have multiple mock tools', () => {
      expect(MOCK_TOOLS.length).toBeGreaterThan(0);
    });

    it('should have cluster_health tool', () => {
      const tool = MOCK_TOOLS.find(t => t.name === 'opensearch_cluster_health');
      expect(tool).toBeDefined();
      expect(tool?.description).toContain('cluster health');
    });

    it('should have cat_nodes tool', () => {
      const tool = MOCK_TOOLS.find(t => t.name === 'opensearch_cat_nodes');
      expect(tool).toBeDefined();
    });

    it('should have nodes_stats tool', () => {
      const tool = MOCK_TOOLS.find(t => t.name === 'opensearch_nodes_stats');
      expect(tool).toBeDefined();
    });

    it('should have valid tool structure', () => {
      MOCK_TOOLS.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
      });
    });

    it('should have opensearch-prefixed tool names', () => {
      MOCK_TOOLS.forEach(tool => {
        expect(tool.name).toMatch(/^opensearch_/);
      });
    });

    describe('judge models (Opus 4.7/4.8 Bedrock contract)', () => {
      // The real Bedrock inference profiles have NO `-v1` for 4.7+ (verified via
      // `aws bedrock list-inference-profiles`). `…-v1` 500s with "model
      // identifier is invalid". PR #347 fixed 4.8; this guards 4.7 too.
      it('maps Opus 4.7 and 4.8 to the real (no -v1) inference profiles', () => {
        expect(DEFAULT_CONFIG.models['claude-opus-4.8'].model_id).toBe('us.anthropic.claude-opus-4-8');
        expect(DEFAULT_CONFIG.models['claude-opus-4.7'].model_id).toBe('us.anthropic.claude-opus-4-7');
      });
    });
  });

});
