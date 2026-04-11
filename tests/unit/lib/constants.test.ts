/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_PRICING, DEFAULT_CONFIG, MOCK_TOOLS } from '@/lib/constants';

describe('lib/constants', () => {
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

      it('should have claude-opus-4.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-opus-4.5'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-opus-4-5-20251101-v1:0');
        expect(model.display_name).toBe('Claude Opus 4.5');
        expect(model.max_output_tokens).toBe(64000);
      });

      it('should have claude-opus-4.1 model', () => {
        const model = DEFAULT_CONFIG.models['claude-opus-4.1'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-opus-4-1-20250805-v1:0');
        expect(model.display_name).toBe('Claude Opus 4.1');
        expect(model.max_output_tokens).toBe(32000);
      });

      it('should have claude-opus-4 model', () => {
        const model = DEFAULT_CONFIG.models['claude-opus-4'];
        expect(model).toBeDefined();
        expect(model.model_id).toBe('us.anthropic.claude-opus-4-20250514-v1:0');
        expect(model.display_name).toBe('Claude Opus 4');
        expect(model.max_output_tokens).toBe(32000);
      });

      it('should have claude-sonnet-4 model', () => {
        const model = DEFAULT_CONFIG.models['claude-sonnet-4'];
        expect(model).toBeDefined();
        expect(model.model_id).toContain('claude-sonnet-4');
        expect(model.display_name).toBe('Claude Sonnet 4');
        expect(model.context_window).toBe(200000);
        expect(model.max_output_tokens).toBeGreaterThan(0);
      });

      it('should have claude-sonnet-4.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-sonnet-4.5'];
        expect(model).toBeDefined();
        expect(model.display_name).toBe('Claude Sonnet 4.5');
      });

      it('should have claude-haiku-3.5 model', () => {
        const model = DEFAULT_CONFIG.models['claude-haiku-3.5'];
        expect(model).toBeDefined();
        expect(model.display_name).toBe('Claude Haiku 3.5');
      });

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
  });

});
