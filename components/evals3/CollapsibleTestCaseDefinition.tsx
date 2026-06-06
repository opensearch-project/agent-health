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
 *     file path. We can't render the `evaluate` function body because
 *     it's a JS function reference at runtime, but the path is enough
 *     for the user to jump to the source in their editor.
 *
 *   • JSON tests (no sourceFile) — show the full TestCase object as
 *     pretty-printed JSON. **No truncation** — the whole point of
 *     opening this section is to see the full prompt / expected
 *     outcomes / labels at once.
 *
 * Defaults to closed; opens on header click. The component is small and
 * stateless from the caller's perspective — drop it in wherever a
 * `testCase` is in scope.
 */

import React, { useState } from 'react';
import { ChevronRight, ChevronDown, FileCode2, Braces, Copy, Check } from 'lucide-react';
import { TestCase } from '@/types';
import { Badge } from '@/components/ui/badge';

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
  const [copied, setCopied] = useState(false);

  if (!testCase) return null;

  const isSdk = !!testCase.sourceFile;
  // Pretty-print the full TestCase. The whole point of the JSON view is to
  // show the user exactly what would round-trip through `agent-health
  // export` — so include every field, including labels / expectedOutcomes /
  // versions, untruncated.
  const json = isSdk ? '' : JSON.stringify(testCase, null, 2);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = isSdk ? testCase.sourceFile! : json;
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
            // SDK test: show the source path. We can't render the evaluate()
            // function body because it's only available at runtime as a JS
            // closure, but the path lets the user jump to it.
            <div className="space-y-2">
              <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                Source File
              </div>
              <div className="flex items-center gap-2 bg-card rounded border border-border px-3 py-2">
                <FileCode2 size={12} className="text-muted-foreground shrink-0" />
                <code className="text-[11px] font-mono break-all flex-1">
                  {testCase.sourceFile}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 rounded hover:bg-muted shrink-0"
                  title="Copy path"
                >
                  {copied ? <Check size={11} className="text-green-600" /> : <Copy size={11} className="text-muted-foreground" />}
                </button>
              </div>
              {testCase.sourceHash && (
                <div className="text-[9px] text-muted-foreground font-mono">
                  sha256: {testCase.sourceHash.slice(0, 16)}…
                </div>
              )}
              <div className="text-[10px] text-muted-foreground italic">
                The <code className="font-mono">evaluate()</code> body lives in the source file above and isn't serializable from runtime state.
              </div>
            </div>
          ) : (
            // JSON test: full untruncated pretty-print, copyable.
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Full Definition (JSON)
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
              {/* No max-height / no scroll — user explicitly wants no truncation.
                  The outer page already provides scroll if the JSON gets very tall. */}
              <pre className="text-[10px] font-mono bg-card border border-border rounded p-3 whitespace-pre-wrap break-words overflow-x-auto leading-relaxed">
                {json}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default CollapsibleTestCaseDefinition;
