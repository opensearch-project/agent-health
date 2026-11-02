/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renders a deterministic scoring's `ScoringDiagnostics` — where the gold
 * came from and every candidate source the extractor tried, in order, with
 * counts (lib/scoring/prediction/candidates.ts). Shown on the retry dialog's
 * per-case rows and on the run report's Judge tab so a "not evaluable" never
 * reads as a bare "no candidate ids found" (owner: "this doesn't show the
 * right error").
 */

import React from 'react';
import type { ScoringDiagnostics } from '@/types';

export const describeGold = (d: ScoringDiagnostics): string =>
  d.gold.explicitlyEmpty
    ? `gold explicitly empty (${d.gold.source})`
    : d.gold.ids.length > 0
      ? `gold ${d.gold.ids.length} id${d.gold.ids.length === 1 ? '' : 's'} from ${d.gold.source}`
      : 'gold not declared';

export const ScoringDiagnosticsView: React.FC<{ diagnostics: ScoringDiagnostics; testId?: string; className?: string }> = ({ diagnostics: d, testId, className }) => {
  let marked = false;
  return (
    <div className={`text-[11px] leading-snug space-y-0.5 ${className ?? ''}`} data-testid={testId ?? 'scoring-diagnostics'}>
      <div>
        <span className="text-muted-foreground">Gold: </span>
        <span data-testid="scoring-diagnostics-gold">{describeGold(d)}</span>
        {d.gold.ids.length > 0 && <span className="text-muted-foreground font-mono"> [{d.gold.ids.slice(0, 8).join(', ')}{d.gold.ids.length > 8 ? ', …' : ''}]</span>}
      </div>
      <div>
        <span className="text-muted-foreground">Candidates: </span>
        <ul className="inline" data-testid="scoring-diagnostics-sources">
          {d.candidates.sourceTried.length === 0 && <li className="inline">no source produced candidates</li>}
          {d.candidates.sourceTried.map((a, i) => {
            const used = !marked && a.source === d.candidates.sourceUsed && a.count === d.candidates.count;
            if (used) marked = true;
            return (
              <li key={i} className="inline">
                {i > 0 && <span className="text-muted-foreground">, </span>}
                <span className={used ? 'font-medium' : ''}>{a.count} from {a.detail}</span>
                {used && <span className="text-green-700 dark:text-green-400"> (used)</span>}
              </li>
            );
          })}
        </ul>
        {d.candidates.anchorRemoved > 0 && <span>; anchor removed {d.candidates.anchorRemoved}</span>}
        {d.candidates.weak && <span className="text-amber-700 dark:text-amber-300"> (weak: generic scan)</span>}
        {d.candidates.sourceUsed === 'none' && <span className="text-amber-700 dark:text-amber-300"> — no source used</span>}
      </div>
      {d.toolsScanned.length > 0 && (
        <div>
          <span className="text-muted-foreground">Tools scanned: </span>
          <span className="font-mono" data-testid="scoring-diagnostics-tools">{d.toolsScanned.join(', ')}</span>
        </div>
      )}
    </div>
  );
};
