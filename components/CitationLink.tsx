/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import { parseCitationHref } from '@/lib/citations';

interface CitationLinkProps {
  href?: string;
  children?: React.ReactNode;
  onStepClick?: (stepNumber: number) => void;
  onSpanClick?: (runId: string, spanId: string) => void;
  canOpenStep?: (stepNumber: number) => boolean;
  canOpenSpan?: (runId: string, spanId: string) => boolean;
  spanPrefix?: (runId: string) => React.ReactNode;
  spanTitle?: (runId: string, spanId: string) => string;
}

/** Shared renderer for judge-authored step and span citations. */
export const CitationLink: React.FC<CitationLinkProps> = ({
  href,
  children,
  onStepClick,
  onSpanClick,
  canOpenStep,
  canOpenSpan,
  spanPrefix,
  spanTitle,
}) => {
  const citation = parseCitationHref(href);
  const citationClass = 'inline-flex items-center gap-0.5 align-baseline rounded bg-opensearch-blue/10 px-1.5 py-0.5 text-[0.85em] font-medium text-opensearch-blue hover:bg-opensearch-blue/20 transition-colors';

  if (citation?.type === 'step') {
    const enabled = Boolean(onStepClick) && (canOpenStep?.(citation.stepNumber) ?? true);
    if (!enabled) return <span>{children}</span>;
    return (
      <button
        type="button"
        data-step-number={citation.stepNumber}
        onClick={() => onStepClick?.(citation.stepNumber)}
        title={`Open Step ${citation.stepNumber} in Test Case Output`}
        className={citationClass}
      >
        {children}
        <ArrowUpRight size={11} className="flex-shrink-0" />
      </button>
    );
  }

  if (citation?.type === 'span') {
    const enabled = Boolean(onSpanClick) && (canOpenSpan?.(citation.runId, citation.spanId) ?? true);
    if (!enabled) return <span>{children}</span>;
    return (
      <button
        type="button"
        data-span-id={citation.spanId}
        data-run-id={citation.runId}
        onClick={() => onSpanClick?.(citation.runId, citation.spanId)}
        title={spanTitle?.(citation.runId, citation.spanId) || 'Open this span in the Traces tab'}
        className={citationClass}
      >
        {spanPrefix?.(citation.runId)}
        {children}
        <ArrowUpRight size={11} className="flex-shrink-0" />
      </button>
    );
  }

  // `href` has already passed sanitizeCitationUrl through ReactMarkdown.
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-opensearch-blue hover:underline">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
};
