/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-time "Want me to explain this run?" nudge (route-derived, sessionStorage
 * de-duped via useAssistantSuggestions). Clicking it opens the assistant panel
 * and asks the route's first suggested question.
 */

import React from 'react';
import { useAssistantSuggestions } from '@/hooks/useAssistantSuggestions';
import { openAskPanel } from './askState';

export const AskNudge: React.FC = () => {
  const { nudge, suggestions, dismissNudge } = useAssistantSuggestions();
  if (!nudge) return null;
  return (
    <div className="fixed right-4 bottom-4 z-40 flex items-center gap-1" data-ask-ui>
      <button
        type="button"
        onClick={() => { dismissNudge(); openAskPanel({ question: suggestions[0] }); }}
        className="max-w-[260px] rounded-lg border bg-background px-3 py-2 text-xs shadow-md hover:bg-accent transition-colors flex items-center gap-2 animate-in fade-in slide-in-from-bottom-2 duration-300"
        data-testid="ask-nudge"
      >
        <span aria-hidden="true">✨</span>
        <span className="text-left">{nudge}</span>
      </button>
      <button type="button" onClick={dismissNudge} aria-label="Dismiss" className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent" data-testid="ask-nudge-dismiss">×</button>
    </div>
  );
};
