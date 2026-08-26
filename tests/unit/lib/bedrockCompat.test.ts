/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  modelSupportsTemperature,
  buildInferenceConfig,
  regionInferencePrefix,
  resolveRegionAwareModelId,
} from '@/lib/bedrockCompat';

describe('bedrockCompat', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('modelSupportsTemperature', () => {
    it.each([
      'us.anthropic.claude-opus-4-5',
      'us.anthropic.claude-opus-4-6-v1',
      'us.anthropic.claude-opus-4-7',
      'us.anthropic.claude-opus-4-8',
      'us.anthropic.claude-sonnet-4-6',
      'us.anthropic.claude-fable-5',
      'anthropic.claude-fable-5',
      'eu.anthropic.claude-opus-4-8',
    ])('returns false for models that deprecated temperature: %s', (id) => {
      expect(modelSupportsTemperature(id)).toBe(false);
    });

    it.each([
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'us.anthropic.claude-opus-4-1',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
      'gpt-4o',
      'mock://demo-model',
      '',
    ])('returns true for models that still accept temperature: %s', (id) => {
      expect(modelSupportsTemperature(id)).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(modelSupportsTemperature('US.Anthropic.Claude-Opus-4-8')).toBe(false);
    });
  });

  describe('buildInferenceConfig', () => {
    it('includes temperature for models that accept it', () => {
      expect(
        buildInferenceConfig('us.anthropic.claude-sonnet-4-5-20250929-v1:0', {
          maxTokens: 4096,
          temperature: 0.7,
        }),
      ).toEqual({ maxTokens: 4096, temperature: 0.7 });
    });

    it('omits temperature for models that deprecated it', () => {
      const cfg = buildInferenceConfig('us.anthropic.claude-opus-4-8', {
        maxTokens: 4096,
        temperature: 0.7,
      });
      expect(cfg).toEqual({ maxTokens: 4096 });
      expect('temperature' in cfg).toBe(false);
    });

    it('omits temperature when none was requested', () => {
      expect(
        buildInferenceConfig('us.anthropic.claude-sonnet-4-5-20250929-v1:0', { maxTokens: 1024 }),
      ).toEqual({ maxTokens: 1024 });
    });
  });

  describe('regionInferencePrefix', () => {
    it('maps EU regions to eu.', () => {
      expect(regionInferencePrefix('eu-central-1')).toBe('eu.');
    });

    it('maps AP regions to apac.', () => {
      expect(regionInferencePrefix('ap-southeast-2')).toBe('apac.');
    });

    it('maps US regions to us.', () => {
      expect(regionInferencePrefix('us-west-2')).toBe('us.');
    });

    it('falls back to AWS_REGION env var', () => {
      process.env.AWS_REGION = 'eu-west-1';
      expect(regionInferencePrefix()).toBe('eu.');
    });

    it('defaults to us. with no region configured', () => {
      delete process.env.AWS_REGION;
      delete process.env.AWS_DEFAULT_REGION;
      expect(regionInferencePrefix()).toBe('us.');
    });
  });

  describe('resolveRegionAwareModelId', () => {
    it('re-homes a us. profile to eu. in an EU region', () => {
      expect(resolveRegionAwareModelId('us.anthropic.claude-opus-4-8', 'eu-central-1')).toBe(
        'eu.anthropic.claude-opus-4-8',
      );
    });

    it('re-homes a us. profile to apac. in an AP region', () => {
      expect(
        resolveRegionAwareModelId('us.anthropic.claude-sonnet-4-6', 'ap-northeast-1'),
      ).toBe('apac.anthropic.claude-sonnet-4-6');
    });

    it('keeps a us. profile unchanged in a US region', () => {
      expect(resolveRegionAwareModelId('us.anthropic.claude-opus-4-8', 'us-east-1')).toBe(
        'us.anthropic.claude-opus-4-8',
      );
    });

    it('re-homes an eu. profile back to us. in a US region', () => {
      expect(resolveRegionAwareModelId('eu.anthropic.claude-opus-4-8', 'us-west-2')).toBe(
        'us.anthropic.claude-opus-4-8',
      );
    });

    it('leaves global. profiles unchanged', () => {
      expect(resolveRegionAwareModelId('global.anthropic.claude-sonnet-4-6', 'eu-central-1')).toBe(
        'global.anthropic.claude-sonnet-4-6',
      );
    });

    it('leaves bare model ids unchanged', () => {
      expect(
        resolveRegionAwareModelId('anthropic.claude-3-5-sonnet-20241022-v2:0', 'eu-central-1'),
      ).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    });

    it('leaves non-Bedrock ids unchanged', () => {
      expect(resolveRegionAwareModelId('gpt-4o', 'eu-central-1')).toBe('gpt-4o');
      expect(resolveRegionAwareModelId('mock://demo-model', 'eu-central-1')).toBe(
        'mock://demo-model',
      );
      expect(resolveRegionAwareModelId('', 'eu-central-1')).toBe('');
    });

    it('uses the process AWS_REGION when no region argument given', () => {
      process.env.AWS_REGION = 'eu-central-1';
      expect(resolveRegionAwareModelId('us.anthropic.claude-opus-4-8')).toBe(
        'eu.anthropic.claude-opus-4-8',
      );
    });
  });
});
