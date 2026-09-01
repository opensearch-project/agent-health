/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Calendar, PackageOpen, Play } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Markdown } from '@/components/ui/markdown';
import { TestCase } from '@/types';
import { getLabelColor, formatDate } from '@/lib/utils';
import { ContextDispositionGroups } from '@/components/ContextDispositionGroups';

interface TestCaseDetailPanelProps {
  testCase: TestCase;
  totalRuns?: number;
}

export interface FixtureTreeEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface FixturePayloadPresentation {
  authoredNotes?: string;
  tree?: FixtureTreeEntry[];
  isManifest: boolean;
  rawJson: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFixtureTreeEntry = (value: unknown): value is FixtureTreeEntry =>
  isRecord(value) &&
  typeof value.path === 'string' &&
  typeof value.size === 'number' &&
  Number.isFinite(value.size) &&
  typeof value.sha256 === 'string';

/** Keep connector-owned payload handling explicit: only the authored manifest
 * shape gets a rich presentation; every other shape remains inspectable JSON. */
export function describeFixturePayload(payload: unknown): FixturePayloadPresentation {
  const manifest = isRecord(payload) && isRecord(payload.manifest) ? payload.manifest : undefined;
  const authoredNotes = typeof manifest?.authoredNotes === 'string' ? manifest.authoredNotes : undefined;
  const tree = Array.isArray(manifest?.tree) && manifest.tree.every(isFixtureTreeEntry)
    ? manifest.tree
    : undefined;

  return {
    authoredNotes,
    tree,
    isManifest: authoredNotes !== undefined || tree !== undefined,
    rawJson: JSON.stringify(payload, null, 2) ?? String(payload),
  };
}

function formatFixtureSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export const TestCaseDetailPanel: React.FC<TestCaseDetailPanelProps> = ({ testCase, totalRuns }) => {
  return (
    <div className="space-y-4">
      {/* Labels */}
      {(testCase.labels || []).length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Labels</h4>
          <div className="flex items-center gap-2 flex-wrap">
            {testCase.labels.map((label) => (
              <Badge key={label} variant="outline" className={getLabelColor(label)}>
                {label}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="space-y-1 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <Calendar size={12} />
          <span>Created {formatDate(testCase.createdAt)}</span>
        </div>
        {totalRuns !== undefined && (
          <div className="flex items-center gap-2">
            <Play size={12} />
            <span>{totalRuns} run{totalRuns !== 1 ? 's' : ''}</span>
          </div>
        )}
      </div>

      {/* Description */}
      {testCase.description && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Description</h4>
          <p className="text-sm text-muted-foreground">{testCase.description}</p>
        </div>
      )}

      {/* Fixture: setup state is part of the scenario, before delivered input. */}
      {testCase.fixture && (
        <div className="space-y-2" data-testid="workspace-fixture">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Workspace fixture</h4>
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <PackageOpen size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
            <p className="min-w-0 break-words">
              <span className="font-mono text-foreground">{testCase.fixture.ref}</span>
              {' — integrity-pinned ('}
              <span className="font-mono">{testCase.fixture.type}</span>
              {'), not disclosed to the agent'}
            </p>
          </div>
          {testCase.fixture.payload !== undefined && (() => {
            const payload = describeFixturePayload(testCase.fixture.payload);
            return (
              <details className="group rounded-md border bg-muted/20">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                  Fixture payload
                </summary>
                <div className="space-y-3 border-t px-3 py-3">
                  <p className="text-xs italic text-muted-foreground">
                    For reviewers and audit — not delivered to the agent, not read by the judge.
                  </p>

                  {payload.authoredNotes !== undefined && (
                    <section className="rounded-md bg-background/60 p-3" aria-label="Fixture authored notes">
                      <Markdown className="text-sm text-foreground/90">{payload.authoredNotes}</Markdown>
                    </section>
                  )}

                  {payload.tree !== undefined && (
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-left text-xs" aria-label="Fixture file tree">
                        <thead className="bg-muted/50 text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1.5 font-medium">Path</th>
                            <th className="px-2 py-1.5 text-right font-medium">Size</th>
                            <th className="px-2 py-1.5 font-medium">SHA-256</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {payload.tree.map(entry => (
                            <tr key={`${entry.path}:${entry.sha256}`}>
                              <td className="px-2 py-1.5 font-mono text-foreground">{entry.path}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-right text-muted-foreground">
                                {formatFixtureSize(entry.size)}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-muted-foreground" title={entry.sha256}>
                                {entry.sha256.slice(0, 12)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <details className="rounded-md border bg-background/40">
                    <summary className="cursor-pointer select-none px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                      Raw JSON
                    </summary>
                    <pre className="max-h-64 overflow-auto border-t px-3 py-2 text-xs whitespace-pre-wrap break-words">
                      {payload.rawJson}
                    </pre>
                  </details>
                </div>
              </details>
            );
          })()}
        </div>
      )}

      {/* Initial Prompt */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Prompt</h4>
        <Card className="bg-muted/30">
          <CardContent className="p-3">
            <p className="text-sm whitespace-pre-wrap">{testCase.initialPrompt}</p>
          </CardContent>
        </Card>
      </div>

      {/* Expected Outcomes */}
      {testCase.expectedOutcomes && testCase.expectedOutcomes.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected Outcomes</h4>
          <ul className="space-y-1">
            {testCase.expectedOutcomes.map((outcome, i) => (
              <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                <span className="text-opensearch-blue mt-0.5">•</span>
                <span>{outcome}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Context */}
      {testCase.context && testCase.context.length > 0 && (
        <ContextDispositionGroups items={testCase.context} />
      )}

      {/* Tools */}
      {testCase.tools && testCase.tools.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Tools ({testCase.tools.length})</h4>
          <div className="flex flex-wrap gap-1">
            {testCase.tools.map((tool, i) => (
              <Badge key={i} variant="secondary" className="text-xs">
                {tool.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Expected PPL */}
      {testCase.expectedPPL && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Expected PPL</h4>
          <Card className="bg-muted/30">
            <CardContent className="p-2">
              <pre className="text-xs overflow-x-auto">{testCase.expectedPPL}</pre>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
};
