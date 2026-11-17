/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Check } from 'lucide-react';
import { BenchmarkRun } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { getRunModelLabel } from '@/lib/utils';

export interface RunPairSelectorProps {
  runs: BenchmarkRun[];
  selectedRunIds: string[];
  onSelect: (runA: string, runB: string) => void;
  onCancel: () => void;
}

const getAgentName = (key: string) =>
  DEFAULT_CONFIG.agents.find(a => a.key === key)?.name || key;

export const RunPairSelector: React.FC<RunPairSelectorProps> = ({
  runs,
  selectedRunIds,
  onSelect,
  onCancel,
}) => {
  const [checkedIds, setCheckedIds] = useState<string[]>([]);

  const availableRuns = runs.filter(r => selectedRunIds.includes(r.id));

  const toggleRun = (runId: string) => {
    setCheckedIds(prev => {
      if (prev.includes(runId)) {
        return prev.filter(id => id !== runId);
      }
      if (prev.length >= 2) {
        // Replace the first selection with the new one
        return [prev[1], runId];
      }
      return [...prev, runId];
    });
  };

  const handleCompare = () => {
    if (checkedIds.length === 2) {
      onSelect(checkedIds[0], checkedIds[1]);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <h4 className="text-sm font-semibold text-foreground mb-3">
        Select 2 runs for trajectory comparison
      </h4>

      <div className="space-y-2 mb-4">
        {availableRuns.map(run => {
          const isChecked = checkedIds.includes(run.id);
          return (
            <button
              key={run.id}
              type="button"
              onClick={() => toggleRun(run.id)}
              className={`w-full flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                isChecked
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-background hover:bg-muted/50'
              }`}
            >
              <div
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                  isChecked
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/40'
                }`}
              >
                {isChecked && <Check className="h-3 w-3" />}
              </div>

              <div className="flex-1 min-w-0">
                <span className="font-medium text-foreground truncate block">
                  {run.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {getAgentName(run.agentKey)}
                  {' · '}
                  {getRunModelLabel(run)}
                </span>
              </div>

              {isChecked && (
                <Badge variant="secondary" className="text-xs shrink-0">
                  {checkedIds.indexOf(run.id) + 1}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={checkedIds.length !== 2}
          onClick={handleCompare}
        >
          Compare
        </Button>
      </div>
    </div>
  );
};
