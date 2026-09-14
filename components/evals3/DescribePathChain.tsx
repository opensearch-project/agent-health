/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ChevronRight, FolderTree } from 'lucide-react';
import type { TestCase } from '@/types';

/**
 * The `describe()` chain a code-SDK test case was registered under, rendered
 * read-only as a breadcrumb (outermost first). Renders NOTHING when the case
 * has no chain — JSON/UI-authored cases and code cases imported before
 * `describePath` was persisted must not show an empty or "undefined" group.
 */
export function hasDescribePath(testCase: Pick<TestCase, 'describePath'>): testCase is Pick<TestCase, 'describePath'> & { describePath: string[] } {
  return Array.isArray(testCase.describePath) && testCase.describePath.length > 0 && testCase.describePath.every(s => typeof s === 'string');
}

export const DescribePathChain: React.FC<{
  testCase: Pick<TestCase, 'describePath'>;
  className?: string;
  /** Show the "Describe" label prefix (default true). */
  withLabel?: boolean;
}> = ({ testCase, className = '', withLabel = true }) => {
  if (!hasDescribePath(testCase)) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-1 text-xs text-muted-foreground ${className}`}
      data-testid="describe-path-chain"
      aria-label={`Describe chain: ${testCase.describePath.join(' > ')}`}
    >
      <FolderTree size={13} className="shrink-0" aria-hidden="true" />
      {withLabel && <span className="font-semibold uppercase tracking-wide text-[10px]">Describe</span>}
      {testCase.describePath.map((title, index) => (
        <React.Fragment key={`${index}-${title}`}>
          {index > 0 && <ChevronRight size={11} className="shrink-0 opacity-60" aria-hidden="true" />}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground" data-testid="describe-path-segment">{title}</code>
        </React.Fragment>
      ))}
    </div>
  );
};
