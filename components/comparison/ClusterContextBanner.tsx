/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Sparkles, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ClusterContextRecord } from '@/services/client/comparisonClusterApi';

interface ClusterContextBannerProps {
  context: ClusterContextRecord;
  /** Called when the user dismisses the banner — page should clear local
   *  cluster-derived prefilled state if it had any. Optional. */
  onDismiss?: () => void;
}

/**
 * Compact banner that shows up on receiving pages (Skills, Settings,
 * TestCases) when the user arrived via a "next-step" button on the
 * comparison page. Tells them why they're here and lets them go back
 * to the comparison page in one click.
 */
export const ClusterContextBanner: React.FC<ClusterContextBannerProps> = ({
  context,
  onDismiss,
}) => {
  const navigate = useNavigate();
  return (
    <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 px-3 py-2 text-xs flex items-start gap-2">
      <Sparkles size={14} className="text-purple-300 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-foreground">
          Coming from <span className="text-purple-300">{context.name}</span>
          {context.loserLabel && context.winnerLabel && (
            <span className="text-muted-foreground font-normal">
              {' '}— {context.loserLabel} failed where {context.winnerLabel} passed
            </span>
          )}
        </div>
        <div className="text-muted-foreground leading-snug mt-0.5">
          {context.summary}
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          {context.caseIds.length} failing case{context.caseIds.length === 1 ? '' : 's'}: {context.caseIds.slice(0, 3).join(', ')}
          {context.caseIds.length > 3 ? ` +${context.caseIds.length - 3} more` : ''}
        </div>
      </div>
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="text-[10px] text-primary hover:underline shrink-0 mt-0.5"
        title="Back to the comparison page"
      >
        ← Back
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground shrink-0"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
};
