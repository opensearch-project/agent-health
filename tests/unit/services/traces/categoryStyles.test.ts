/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for Category Styles
 */

import { getCategoryColors, CATEGORY_COLORS } from '@/services/traces/categoryStyles';

describe('getCategoryColors', () => {
  it('returns correct colors for AGENT category', () => {
    const colors = getCategoryColors('AGENT');

    expect(colors.border).toBe('border-indigo-500/50');
    expect(colors.bg).toBe('bg-indigo-500/10');
    expect(colors.text).toBe('text-indigo-400');
    expect(colors.bar).toBe('bg-indigo-500');
    expect(colors.chipHover).toBe('hover:bg-indigo-500/20');
  });

  it('returns correct colors for LLM category', () => {
    const colors = getCategoryColors('LLM');

    expect(colors.border).toBe('border-purple-500/50');
    expect(colors.bg).toBe('bg-purple-500/10');
    expect(colors.text).toBe('text-purple-400');
    expect(colors.bar).toBe('bg-purple-500');
  });

  it('returns correct colors for TOOL category', () => {
    const colors = getCategoryColors('TOOL');

    expect(colors.border).toBe('border-amber-500/50');
    expect(colors.bg).toBe('bg-amber-500/10');
    expect(colors.text).toBe('text-amber-400');
    expect(colors.bar).toBe('bg-amber-500');
  });

  it('returns correct colors for ERROR category', () => {
    const colors = getCategoryColors('ERROR');

    expect(colors.border).toBe('border-red-500/50');
    expect(colors.bg).toBe('bg-red-500/10');
    expect(colors.text).toBe('text-red-400');
    expect(colors.bar).toBe('bg-red-500');
  });

  it('returns OTHER colors for unknown category', () => {
    const colors = getCategoryColors('UNKNOWN');

    expect(colors).toEqual(CATEGORY_COLORS.OTHER);
    expect(colors.border).toBe('border-slate-500/50');
    expect(colors.text).toBe('text-slate-400');
  });

  it('returns OTHER colors for empty string', () => {
    const colors = getCategoryColors('');

    expect(colors).toEqual(CATEGORY_COLORS.OTHER);
  });
});

describe('CATEGORY_COLORS', () => {
  it('has all required categories defined', () => {
    expect(CATEGORY_COLORS.AGENT).toBeDefined();
    expect(CATEGORY_COLORS.LLM).toBeDefined();
    expect(CATEGORY_COLORS.TOOL).toBeDefined();
    expect(CATEGORY_COLORS.ERROR).toBeDefined();
    expect(CATEGORY_COLORS.OTHER).toBeDefined();
  });

  it('each category has all required properties', () => {
    const requiredProps = ['border', 'bg', 'text', 'bar', 'chipHover'];

    Object.values(CATEGORY_COLORS).forEach((config) => {
      requiredProps.forEach((prop) => {
        expect(config).toHaveProperty(prop);
        expect(typeof config[prop as keyof typeof config]).toBe('string');
      });
    });
  });

  it('all color values are valid Tailwind classes', () => {
    Object.values(CATEGORY_COLORS).forEach((config) => {
      expect(config.border).toMatch(/^border-/);
      expect(config.bg).toMatch(/^bg-/);
      expect(config.text).toMatch(/^text-/);
      expect(config.bar).toMatch(/^bg-/);
      expect(config.chipHover).toMatch(/^hover:bg-/);
    });
  });
});
