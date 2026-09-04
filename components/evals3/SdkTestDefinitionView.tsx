/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SdkTestDefinitionView
 *
 * The definition surface for a code-SDK test case (`testCase.sourceFile`
 * set). Answers "what is THIS test?" the way the JSON definition block does
 * for JSON test cases — instead of dumping the whole eval file, in which a
 * generated suite may register dozens of tests from a loop and "the test"
 * is nowhere to be seen.
 *
 * Layout: the `<file>.eval.js` header row (path, language badge) followed
 * by a segmented control:
 *
 *   • Pretty (default)   — `definition.options` (the resolved `test()`
 *                          options: prompt, expected outcomes, labels,
 *                          description, timeout, context, …) rendered like
 *                          the JSON definition, via TestCaseDefinition.
 *   • Evaluate function  — `definition.bodySource` (the evaluate callback
 *                          text) with the same prism highlighting the
 *                          whole-file view uses.
 *   • Whole file         — the pre-existing EvalSourceCodeView, so nothing
 *                          is lost for users who want the surrounding file.
 *
 * Backward compat: SDK test cases persisted before `definition` existed
 * fall back to the whole-file view with a one-line "re-import to capture"
 * hint — the Pretty / Evaluate function segments are not offered because
 * there is nothing per-test to show.
 */

import React, { useMemo, useState } from 'react';
import { FileCode2, AlertCircle } from 'lucide-react';
import { TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { detectSourceLanguage } from '@/lib/utils';
import { EvalSourceCodeView } from '@/components/evals3/EvalSourceCodeView';
import { HighlightedCodeBlock } from '@/components/evals3/HighlightedCodeBlock';
import { TestCaseDefinition } from '@/components/TestCaseDefinition';

export type SdkDefinitionSegment = 'pretty' | 'evaluate' | 'file';

interface SdkTestDefinitionViewProps {
  testCase: TestCase | null;
  /** Max height of the scrollable code regions. Default: 360px. */
  maxHeight?: string;
  /** Tighter typography for narrow split-pane layouts (passed to TestCaseDefinition). */
  compact?: boolean;
  className?: string;
}

/**
 * Project `definition.options` onto the TestCase shape TestCaseDefinition
 * renders, so the Pretty view is *exactly* the JSON definition block fed by
 * this test's options rather than by the (equivalent, but loader-derived)
 * top-level fields. `sourceFile` is deliberately omitted so
 * TestCaseDefinition doesn't render its "Source File" pointer row — the
 * filename header above already shows the path.
 */
function optionsToDefinitionShape(testCase: TestCase): TestCase {
  const o = (testCase.definition?.options ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
  return {
    ...testCase,
    sourceFile: undefined,
    description: str(o.description) ?? '',
    initialPrompt: str(o.prompt),
    labels: strArr(o.labels) ?? [],
    expectedOutcomes: strArr(o.expectedOutcomes),
    context: Array.isArray(o.context) ? (o.context as TestCase['context']) : [],
    expectedTrajectory: Array.isArray(o.expectedTrajectory)
      ? (o.expectedTrajectory as TestCase['expectedTrajectory'])
      : undefined,
  };
}

const SEGMENTS: Array<{ id: SdkDefinitionSegment; label: string }> = [
  { id: 'pretty', label: 'Pretty' },
  { id: 'evaluate', label: 'Evaluate function' },
  { id: 'file', label: 'Whole file' },
];

export const SdkTestDefinitionView: React.FC<SdkTestDefinitionViewProps> = ({
  testCase,
  maxHeight = '360px',
  compact = true,
  className,
}) => {
  const [segment, setSegment] = useState<SdkDefinitionSegment>('pretty');

  const language = useMemo(
    () => testCase?.sourceLanguage || detectSourceLanguage(testCase?.sourceFileName || testCase?.sourceFile || ''),
    [testCase?.sourceLanguage, testCase?.sourceFileName, testCase?.sourceFile]
  );
  const prettyShape = useMemo(
    () => (testCase && testCase.definition ? optionsToDefinitionShape(testCase) : null),
    [testCase]
  );

  if (!testCase || !testCase.sourceFile) return null;

  const definition = testCase.definition;
  const timeout = typeof definition?.options?.timeout === 'number' ? (definition.options.timeout as number) : undefined;

  // Legacy record: no per-test capture. Whole-file view + hint, nothing else.
  if (!definition) {
    return (
      <div className={`space-y-2 ${className || ''}`} data-testid="sdk-test-definition-view" data-mode="legacy">
        <div
          className="flex items-start gap-2 text-[10px] text-muted-foreground bg-muted/30 border border-border rounded px-2.5 py-1.5"
          data-testid="sdk-definition-legacy-hint"
        >
          <AlertCircle size={12} className="shrink-0 mt-px text-amber-500" />
          <span>
            Per-test definition not captured at import — showing the whole eval file. Re-import this file
            (<code className="font-mono">agent-health benchmark -f …</code>) to capture this test's options and evaluate
            function; the record is backfilled in place, no new version.
          </span>
        </div>
        <EvalSourceCodeView testCase={testCase} maxHeight={maxHeight} />
      </div>
    );
  }

  const fileName = testCase.sourceFile || testCase.sourceFileName || 'source file';

  return (
    <div className={`border border-border rounded overflow-hidden ${className || ''}`} data-testid="sdk-test-definition-view" data-mode="captured">
      {/* Filename header — the `<file>.eval.js` row the segments hang under. */}
      <div className="flex items-center gap-2 bg-card px-3 py-1.5 border-b border-border">
        <FileCode2 size={12} className="text-muted-foreground shrink-0" />
        <span className="text-[11px] font-mono font-medium truncate flex-1" title={testCase.sourceFile}>
          {fileName}
        </span>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">
          {language === 'typescript' ? 'TypeScript' : 'JavaScript'}
        </Badge>
        <div
          role="tablist"
          aria-label="Test definition view"
          className="inline-flex items-center rounded-md bg-muted p-0.5 shrink-0"
          data-testid="sdk-definition-segments"
        >
          {SEGMENTS.map(s => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={segment === s.id}
              data-testid={`sdk-definition-segment-${s.id}`}
              onClick={() => setSegment(s.id)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                segment === s.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {segment === 'pretty' && prettyShape && (
        <div
          className="px-3 py-2.5 space-y-2 overflow-y-auto"
          style={{ maxHeight }}
          data-testid="sdk-definition-pretty"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground">
              <code className="font-mono text-foreground">test(</code>
              <span className="font-mono text-foreground">&quot;{testCase.name}&quot;</span>
              <code className="font-mono text-foreground">, …)</code>
            </span>
            {timeout !== undefined && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0" data-testid="sdk-definition-timeout">
                timeout {timeout} ms
              </Badge>
            )}
          </div>
          <TestCaseDefinition testCase={prettyShape} compact={compact} />
        </div>
      )}

      {segment === 'evaluate' && (
        definition.bodySource ? (
          <div data-testid="sdk-definition-evaluate">
            <HighlightedCodeBlock
              code={definition.bodySource}
              language={language}
              maxHeight={maxHeight}
              testId="sdk-definition-evaluate-body"
              gutterTestId="sdk-definition-evaluate-line-numbers"
            />
            {definition.bodyTruncated && (
              <div className="px-3 py-1 text-[10px] text-muted-foreground border-t border-border italic">
                Evaluate body truncated at import — switch to “Whole file” for the full text.
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-3 text-[11px] text-muted-foreground italic" data-testid="sdk-definition-evaluate">
            No evaluate function captured for this test.
          </div>
        )
      )}

      {segment === 'file' && (
        <div className="p-2" data-testid="sdk-definition-file">
          <EvalSourceCodeView testCase={testCase} maxHeight={maxHeight} defaultOpen />
        </div>
      )}
    </div>
  );
};

export default SdkTestDefinitionView;
