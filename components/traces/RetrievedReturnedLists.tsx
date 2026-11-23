/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RetrievedReturnedLists
 *
 * The labelled retrieved/returned id pair for a span (see
 * services/traces/retrievalSpan.ts, "Retrieved vs returned"). Renders nothing
 * when the span carries neither key family, so every drawer can mount it
 * unconditionally. Each side shows its attribute name(s), a distinct-id count
 * and the ids themselves; when both sides are present the overlap line says
 * how many retrieved ids made it into the answer.
 */

import React, { useMemo } from 'react';
import { Eye, SendHorizontal } from 'lucide-react';
import { Span } from '@/types';
import {
  extractRetrievedVsReturned,
  describeOverlap,
  RetrievalIdList,
} from '@/services/traces/retrievalSpan';

interface RetrievedReturnedListsProps {
  span: Span;
  /** Compact = drawer strip (smaller type, shorter id list before scrolling). */
  compact?: boolean;
  /** Applied to the root only when there is something to render. */
  className?: string;
}

const IdColumn: React.FC<{
  testId: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
  lists: RetrievalIdList[];
  ids: string[];
  tone: string;
  compact: boolean;
}> = ({ testId, title, hint, icon, lists, ids, tone, compact }) => {
  const raws = lists.filter(l => l.raw !== undefined);
  return (
    <div className="min-w-0 flex-1 rounded-md border bg-muted/20" data-testid={testId}>
      <div className={`flex items-center gap-1.5 px-2 py-1 border-b ${tone}`}>
        {icon}
        <span className="font-semibold uppercase tracking-wide text-[10px]">{title}</span>
        <span className="text-muted-foreground text-[10px]" title={hint}>
          · {ids.length} id{ids.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="px-2 py-1 text-[10px] font-mono text-muted-foreground break-all">
        {lists.map(l => l.attribute).join(', ')}
      </div>
      {ids.length > 0 && (
        <ul
          className={`px-2 pb-1.5 font-mono text-[11px] leading-4 overflow-auto ${compact ? 'max-h-24' : 'max-h-40'}`}
          data-testid={`${testId}-ids`}
        >
          {ids.map(id => (
            <li key={id} className="truncate" title={id}>{id}</li>
          ))}
        </ul>
      )}
      {raws.map(r => (
        <div key={r.attribute} className="px-2 pb-1.5 font-mono text-[10px] whitespace-pre-wrap break-words">
          {r.raw}
        </div>
      ))}
    </div>
  );
};

const RetrievedReturnedLists: React.FC<RetrievedReturnedListsProps> = ({ span, compact = false, className }) => {
  const rr = useMemo(() => extractRetrievedVsReturned(span), [span]);
  if (rr.retrieved.length === 0 && rr.returned.length === 0) return null;
  const overlap = describeOverlap(rr);

  return (
    <div className={['space-y-1.5', className].filter(Boolean).join(' ')} data-testid="retrieved-returned-panel">
      <div className="flex gap-2 min-w-0">
        {rr.retrieved.length > 0 && (
          <IdColumn
            testId="retrieved-ids"
            title="Retrieved (seen)"
            hint="Every candidate the agent pulled in — not necessarily what it answered with"
            icon={<Eye size={11} className="shrink-0" />}
            lists={rr.retrieved}
            ids={rr.retrievedIds}
            tone="text-cyan-700 dark:text-cyan-300"
            compact={compact}
          />
        )}
        {rr.returned.length > 0 && (
          <IdColumn
            testId="returned-ids"
            title="Returned (recommended)"
            hint="What the agent actually returned / recommended to the caller"
            icon={<SendHorizontal size={11} className="shrink-0" />}
            lists={rr.returned}
            ids={rr.returnedIds}
            tone="text-emerald-700 dark:text-emerald-300"
            compact={compact}
          />
        )}
      </div>
      {overlap && (
        <div className="text-[11px] text-muted-foreground" data-testid="retrieved-returned-overlap">
          {overlap}
        </div>
      )}
    </div>
  );
};

export default RetrievedReturnedLists;
