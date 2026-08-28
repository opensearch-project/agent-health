/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Calendar, Play } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TestCase } from '@/types';
import { getLabelColor, formatDate } from '@/lib/utils';
import { Markdown } from '@/components/ui/markdown';

interface TestCaseDetailPanelProps {
  testCase: TestCase;
  totalRuns?: number;
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
      {testCase.context && testCase.context.length > 0 && (() => {
        const delivered = testCase.context.filter(ctx => !ctx.disposition || ctx.disposition === 'prompt');
        const directives = testCase.context.filter(ctx => ctx.disposition === 'connector');
        const documentation = testCase.context.filter(ctx => ctx.disposition === 'documentation');
        return (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground" data-testid="context-delivery-summary">
              Agent receives: prompt + {delivered.length} context items · directives: {directives.length} · documentation: {documentation.length}
            </p>
            {delivered.length > 0 && <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Delivered to agent</h4>
              {delivered.map((ctx, i) => (
                <Card key={i} className="bg-muted/30"><CardContent className="p-2">
                  <p className="text-xs font-medium text-muted-foreground mb-1">{ctx.description}</p>
                  <pre className="text-xs overflow-x-auto max-h-20 overflow-y-auto">{ctx.value.slice(0, 200)}{ctx.value.length > 200 ? '...' : ''}</pre>
                </CardContent></Card>
              ))}
            </div>}
            {directives.length > 0 && <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Connector directive — not delivered</h4>
              <div className="flex flex-wrap gap-2">{directives.map((ctx, i) => (
                <Badge key={i} variant="outline" className="font-mono text-xs">{ctx.description}: {ctx.value}</Badge>
              ))}</div>
            </div>}
            {documentation.length > 0 && <div className="space-y-2">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Documentation — not delivered</h4>
              {documentation.map((ctx, i) => <Card key={i} className="bg-muted/30"><CardContent className="p-3">
                <p className="text-xs font-medium text-muted-foreground mb-2">{ctx.description}</p>
                <Markdown className="text-xs">{ctx.value}</Markdown>
              </CardContent></Card>)}
            </div>}
          </div>
        );
      })()}

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
