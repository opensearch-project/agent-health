/**
 * Shared category color styles for trace visualization components
 *
 * Provides consistent Tailwind class names for category-based styling
 * across Intent view, Category Distribution Bar, and other trace visualizations.
 */

import { SpanCategory } from '@/types';

export interface CategoryColorConfig {
  border: string;
  bg: string;
  text: string;
  bar: string;
  chipHover: string;
}

export const CATEGORY_COLORS: Record<SpanCategory | 'OTHER', CategoryColorConfig> = {
  AGENT: {
    border: 'border-indigo-500/50',
    bg: 'bg-indigo-500/10',
    text: 'text-indigo-400',
    bar: 'bg-indigo-500',
    chipHover: 'hover:bg-indigo-500/20',
  },
  LLM: {
    border: 'border-purple-500/50',
    bg: 'bg-purple-500/10',
    text: 'text-purple-400',
    bar: 'bg-purple-500',
    chipHover: 'hover:bg-purple-500/20',
  },
  TOOL: {
    border: 'border-amber-500/50',
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    bar: 'bg-amber-500',
    chipHover: 'hover:bg-amber-500/20',
  },
  ERROR: {
    border: 'border-red-500/50',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    bar: 'bg-red-500',
    chipHover: 'hover:bg-red-500/20',
  },
  OTHER: {
    border: 'border-slate-500/50',
    bg: 'bg-slate-500/10',
    text: 'text-slate-400',
    bar: 'bg-slate-500',
    chipHover: 'hover:bg-slate-500/20',
  },
};

/**
 * Get category colors for a given category string.
 * Falls back to OTHER for unknown categories.
 */
export function getCategoryColors(category: string): CategoryColorConfig {
  return CATEGORY_COLORS[category as SpanCategory] || CATEGORY_COLORS.OTHER;
}
