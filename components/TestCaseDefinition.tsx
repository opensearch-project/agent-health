/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reader-oriented rendering of a test-case definition.
 *
 * Keep this separate from the raw serialized object: run views, test-case
 * pages, and other inspection surfaces should all lead with the task a human
 * needs to understand (input, expectations, and context). Callers that need a
 * debugging/export view can place raw JSON behind a secondary disclosure.
 */

import React from 'react';
import { CheckCircle2, FileCode2 } from 'lucide-react';
import { TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Markdown, hasRealMarkdown } from '@/components/ui/markdown';
import { ContextDispositionGroups } from '@/components/ContextDispositionGroups';
import { parseLabels } from '@/lib/labels';
import { expectedOutcomeText } from '@/lib/testCases/declarativeOutcomes';

interface TestCaseDefinitionProps {
  testCase: TestCase;
  /** Tighter typography for narrow split-pane layouts. */
  compact?: boolean;
  className?: string;
}

const difficultyClasses: Record<string, string> = {
  easy: 'border-green-300 bg-green-50 text-green-700 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-400',
  medium: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400',
  hard: 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400',
};

const SourceFilePointer: React.FC<{ sourceFile: string }> = ({ sourceFile }) => (
  <div className="space-y-2" data-testid="test-case-source-pointer">
    <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">Source File</div>
    <div className="flex items-center gap-2 bg-card rounded border border-border px-3 py-2">
      <FileCode2 size={12} className="text-muted-foreground shrink-0" />
      <code className="text-[11px] font-mono break-all flex-1">{sourceFile}</code>
    </div>
    <div className="text-[10px] text-muted-foreground italic">
      Code-authored test: the <code className="font-mono">evaluate()</code> body lives in the source file and isn't serializable from runtime state.
    </div>
  </div>
);

export const TestCaseDefinition: React.FC<TestCaseDefinitionProps> = ({
  testCase,
  compact = false,
  className = '',
}) => {
  const parsedLabels = parseLabels(testCase.labels || []);
  const hasDeclarativeFields = Boolean(
    testCase.description ||
    testCase.initialPrompt ||
    testCase.expectedOutcomes?.length ||
    testCase.context?.length ||
    testCase.labels?.length ||
    parsedLabels.category ||
    parsedLabels.difficulty ||
    testCase.category ||
    testCase.difficulty
  );

  // A code-authored case may also persist declarative prompt/rubric/context
  // fields. In that mixed shape, provenance supplements the definition rather
  // than replacing it. Only a truly source-only case uses pointer-only mode.
  if (testCase.sourceFile && !hasDeclarativeFields) {
    return <div className={className}><SourceFilePointer sourceFile={testCase.sourceFile} /></div>;
  }

  const category = parsedLabels.category || testCase.category;
  const difficulty = parsedLabels.difficulty || testCase.difficulty;
  const extraLabels = [
    ...(parsedLabels.subcategory ? [parsedLabels.subcategory] : []),
    ...parsedLabels.generic,
  ];
  const textClass = compact ? 'text-[10px]' : 'text-xs';
  const sectionLabelClass = 'text-[9px] font-semibold text-muted-foreground uppercase tracking-wider mb-1';

  return (
    <div className={`space-y-3 min-w-0 ${className}`} data-testid="readable-test-case-definition">
      {testCase.sourceFile && <SourceFilePointer sourceFile={testCase.sourceFile} />}

      <div className="flex flex-wrap items-center gap-1.5">
        {category && (
          <Badge variant="secondary" className={`${textClass} px-2 py-0.5`}>
            {category}
          </Badge>
        )}
        {difficulty && (
          <Badge
            variant="outline"
            className={`${textClass} px-2 py-0.5 ${difficultyClasses[difficulty.toLowerCase()] || ''}`}
          >
            {difficulty}
          </Badge>
        )}
        {extraLabels.map(label => (
          <Badge key={label} variant="outline" className={`${textClass} px-2 py-0.5`}>
            {label}
          </Badge>
        ))}
      </div>

      {testCase.description && (
        <div>
          <div className={sectionLabelClass}>Description</div>
          <p className={`${textClass} text-muted-foreground whitespace-pre-wrap break-words leading-relaxed`}>
            {testCase.description}
          </p>
        </div>
      )}

      <div>
        <div className={sectionLabelClass}>Input</div>
        <div className={`${textClass} bg-card rounded border border-border px-3 py-2 break-words leading-relaxed`}>
          {testCase.initialPrompt
            ? hasRealMarkdown(testCase.initialPrompt)
              ? <Markdown className={textClass}>{testCase.initialPrompt}</Markdown>
              : <span className="whitespace-pre-wrap">{testCase.initialPrompt}</span>
            : <span className="text-muted-foreground italic">No agent prompt (deterministic test)</span>}
        </div>
      </div>

      {testCase.expectedOutcomes && testCase.expectedOutcomes.length > 0 && (
        <div>
          <div className={sectionLabelClass}>Expected outcomes</div>
          <ul className="space-y-1.5">
            {testCase.expectedOutcomes.map((outcome, index) => (
              <li key={index} className={`${textClass} text-muted-foreground flex items-start gap-1.5 leading-relaxed min-w-0`}>
                <CheckCircle2 size={compact ? 10 : 12} className="text-green-500 mt-0.5 shrink-0" aria-hidden="true" />
                <span className="break-words min-w-0">{expectedOutcomeText(outcome)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {testCase.context && testCase.context.length > 0 && (
        <ContextDispositionGroups items={testCase.context} compact={compact} />
      )}
    </div>
  );
};

export default TestCaseDefinition;
