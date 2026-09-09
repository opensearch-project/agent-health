/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HighlightedCodeBlock
 *
 * The IDE-style code body shared by EvalSourceCodeView (whole eval file)
 * and SdkTestDefinitionView (one test's evaluate body): a sticky
 * line-number gutter + prismjs-highlighted JS/TS, scrolling in both axes,
 * never truncated. Extracted so both surfaces render byte-for-byte the
 * same way and the highlighting cost is paid in exactly one place.
 */

import React, { useMemo } from 'react';
import Prism from 'prismjs';
// eslint-disable-next-line import/no-duplicates
import 'prismjs/components/prism-clike.js';
// eslint-disable-next-line import/no-duplicates
import 'prismjs/components/prism-javascript.js';
// eslint-disable-next-line import/no-duplicates
import 'prismjs/components/prism-typescript.js';

export type CodeLanguage = 'javascript' | 'typescript';

export function highlightCode(code: string, language: CodeLanguage): string {
  const grammar = language === 'javascript' ? Prism.languages.javascript : Prism.languages.typescript;
  try {
    return Prism.highlight(code, grammar, language);
  } catch {
    // Prism should never throw on arbitrary text, but if it somehow does,
    // fail open to escaped plain text rather than crashing the page.
    return code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

interface HighlightedCodeBlockProps {
  code: string;
  language: CodeLanguage;
  /** Max height of the scrollable region. Default: 480px. */
  maxHeight?: string;
  /** data-testid for the scroll container. */
  testId?: string;
  /** data-testid for the line-number gutter. */
  gutterTestId?: string;
  className?: string;
}

export const HighlightedCodeBlock: React.FC<HighlightedCodeBlockProps> = ({
  code,
  language,
  maxHeight = '480px',
  testId,
  gutterTestId,
  className,
}) => {
  const highlightedHtml = useMemo(() => highlightCode(code, language), [code, language]);
  const lineCount = code ? code.split('\n').length : 0;
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'),
    [lineCount]
  );

  return (
    <div
      className={`eval-source-code overflow-auto ${className || ''}`}
      style={{ maxHeight }}
      data-testid={testId}
    >
      <div className="flex text-[11px] leading-5 font-mono">
        <pre
          aria-hidden="true"
          data-testid={gutterTestId}
          className="sticky left-0 z-[1] select-none text-right pr-3 pl-3 py-3 m-0 text-muted-foreground/50 bg-muted/40 border-r border-border shrink-0"
        >
          {lineNumbers}
        </pre>
        <pre className="flex-1 py-3 pl-3 pr-4 m-0">
          <code
            className="eval-source-highlight"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        </pre>
      </div>
    </div>
  );
};

export default HighlightedCodeBlock;
