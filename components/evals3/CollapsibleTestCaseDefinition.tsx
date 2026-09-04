/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CollapsibleTestCaseDefinition
 *
 * Reusable collapsible card that surfaces the *full* definition of a
 * test case — used at the top of the right detail pane on both
 * TestCaseDetailPage (test-case-run inspection) and RunInspectorPage
 * (benchmark-run inspection).
 *
 * Two shapes depending on provenance:
 *
 *   • SDK / code-imported tests (`testCase.sourceFile` set) — show the
 *     file path header with a [Pretty | Evaluate function | Whole file]
 *     segmented view of THIS test (SdkTestDefinitionView): the resolved
 *     `test()` options rendered like the JSON definition, the evaluate
 *     callback text, or the whole eval file. Older records without the
 *     per-test `definition` capture fall back to the whole-file view.
 *
 *   • JSON tests (no sourceFile) — lead with a reader-oriented definition
 *     (prompt, expected outcomes, context, and metadata). The complete
 *     serialized object remains available behind a raw-JSON disclosure for
 *     debugging and export verification.
 *
 * Defaults to closed; opens on header click. The component is small and
 * stateless from the caller's perspective — drop it in wherever a
 * `testCase` is in scope.
 */

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, FileCode2, Braces, Copy, Check } from 'lucide-react';
import { TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';
import { SdkTestDefinitionView } from '@/components/evals3/SdkTestDefinitionView';
import { TestCaseDefinition } from '@/components/TestCaseDefinition';

interface CollapsibleTestCaseDefinitionProps {
  testCase: TestCase | null;
  /** Whether the section starts open. Default: false (collapsed). */
  defaultOpen?: boolean;
  className?: string;
}

export const CollapsibleTestCaseDefinition: React.FC<CollapsibleTestCaseDefinitionProps> = ({
  testCase,
  defaultOpen = false,
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [rawOpen, setRawOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!testCase) return null;

  const isSdk = !!testCase.sourceFile;
  // Preserve the complete serialized form for the optional debugging/export
  // view. It is deliberately not mounted until the user asks for raw JSON.
  const json = isSdk ? '' : JSON.stringify(testCase, null, 2);

  // JSON branch only — the SDK branch's copy affordance lives inside
  // SdkTestDefinitionView (the whole-file segment's copy button copies the source).
  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = json;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className={`border-b bg-muted/30 shrink-0 ${className || ''}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-1.5 text-left hover:bg-muted/50 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? <ChevronDown size={12} className="text-muted-foreground shrink-0" /> : <ChevronRight size={12} className="text-muted-foreground shrink-0" />}
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Test Case Definition
          </span>
          {isSdk ? (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 gap-1 shrink-0">
              <FileCode2 size={9} /> SDK
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[9px] px-1.5 py-0 gap-1 shrink-0">
              <Braces size={9} /> JSON
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground truncate" title={testCase.name}>
            {testCase.name}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-3">
          {isSdk ? (
            // SDK test: SdkTestDefinitionView IS the whole surface — its
            // header shows the source path + language badge, so the old
            // standalone "Source File" row and sha256 line stay gone
            // (owner feedback). Pretty view of THIS test by default.
            <SdkTestDefinitionView testCase={testCase} maxHeight="360px" />
          ) : (
            <div className="space-y-3 max-h-[55vh] overflow-y-auto pr-1">
              <TestCaseDefinition testCase={testCase} compact />

              <div className="border-t border-border pt-2">
                <button
                  type="button"
                  onClick={() => setRawOpen(value => !value)}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-1 rounded hover:bg-muted transition-colors"
                  aria-expanded={rawOpen}
                >
                  <Braces size={10} />
                  {rawOpen ? 'Hide raw JSON' : 'View raw JSON'}
                </button>

                {rawOpen && (
                  <div className="space-y-2 mt-2" data-testid="raw-test-case-json">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Raw JSON
                      </div>
                      <button
                        type="button"
                        onClick={handleCopy}
                        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted"
                        title="Copy JSON"
                      >
                        {copied ? (
                          <><Check size={10} className="text-green-600" /> Copied</>
                        ) : (
                          <><Copy size={10} /> Copy</>
                        )}
                      </button>
                    </div>
                    <pre className="text-[10px] font-mono bg-card border border-border rounded p-3 whitespace-pre-wrap break-words overflow-x-auto leading-relaxed">
                      {json}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CollapsibleTestCaseDefinition;
