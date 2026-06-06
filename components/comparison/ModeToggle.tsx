/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { GitCompare, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ComparisonMode } from '@/services/comparisonService';

interface ModeToggleProps {
  mode: ComparisonMode;
  detectedMode: ComparisonMode;
  onChange: (mode: ComparisonMode) => void;
}

/**
 * Small pill toggle that lets the user override the auto-detected comparison mode.
 * 'compare' frames the page around "why is one agent better than another?";
 * 'iterate' frames it as "is my agent improving over runs?".
 */
export const ModeToggle: React.FC<ModeToggleProps> = ({ mode, detectedMode, onChange }) => {
  const isOverridden = mode !== detectedMode;

  return (
    <div
      className="inline-flex items-center rounded-md border border-border bg-background p-0.5 text-[10px]"
      role="radiogroup"
      aria-label="Comparison mode"
    >
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'compare'}
        onClick={() => onChange('compare')}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-sm transition-colors',
          mode === 'compare'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
        title="Compare different agents on the same cases"
      >
        <GitCompare size={11} />
        <span>Compare</span>
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={mode === 'iterate'}
        onClick={() => onChange('iterate')}
        className={cn(
          'flex items-center gap-1 px-2 py-1 rounded-sm transition-colors',
          mode === 'iterate'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground'
        )}
        title="Track one agent across iterations"
      >
        <TrendingUp size={11} />
        <span>Iterate</span>
      </button>
      {isOverridden && (
        <span className="px-1.5 text-[9px] text-amber-500" title="Manually overridden from detected mode">
          ·
        </span>
      )}
    </div>
  );
};
