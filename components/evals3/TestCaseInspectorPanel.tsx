/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * TestCaseInspectorPanel — Right panel for test case inspection
 *
 * Minimal header: test case name + pass/fail status
 * Then tabs: Summary | Conversation | Traces | LLM Judge | Annotations
 */

import React from 'react';
import { CheckCircle2, XCircle, Loader2, Clock, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EvaluationReport, TestCase } from '@/types';
import { RunDetailsContent } from '../RunDetailsContent';
import { type ResultStatus } from './ResultStatus';
import { getRunDisplayName } from '@/lib/utils';
import { CollapsibleTestCaseDefinition } from './CollapsibleTestCaseDefinition';

interface TestCaseInspectorPanelProps {
  report: EvaluationReport;
  testCase: TestCase | null;
  status: ResultStatus;
}

export const TestCaseInspectorPanel: React.FC<TestCaseInspectorPanelProps> = ({
  report,
  testCase,
  status,
}) => {
  // `status` is already verdict-aware (matcherResults wins over a later
  // trace timeout). Do not re-promote metricsStatus=error here or the compact
  // badge would contradict the Overview verdict (#407).
  const displayStatus = status;

  const badgeConfig: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    passed: { icon: <CheckCircle2 size={16} className="text-green-500 shrink-0" />, label: 'PASSED', cls: 'bg-green-100 text-green-700 border-green-300 dark:bg-green-500/15 dark:text-green-400 dark:border-green-500/30' },
    failed: { icon: <XCircle size={16} className="text-red-500 shrink-0" />, label: 'FAILED', cls: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/30' },
    errored: { icon: <AlertTriangle size={16} className="text-amber-500 shrink-0" />, label: 'ERRORED', cls: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30' },
    pending_traces: { icon: <Loader2 size={16} className="text-amber-500 animate-spin shrink-0" />, label: 'AWAITING TRACES', cls: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30' },
    pending_judgment: { icon: <Loader2 size={16} className="text-purple-500 animate-spin shrink-0" />, label: 'JUDGING', cls: 'bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/30' },
    pending: { icon: <Clock size={16} className="text-muted-foreground shrink-0" />, label: 'PENDING', cls: 'bg-muted text-muted-foreground border-border' },
    running: { icon: <Loader2 size={16} className="text-blue-500 animate-spin shrink-0" />, label: 'RUNNING', cls: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/30' },
  };
  const badge = badgeConfig[displayStatus] || badgeConfig.pending;

  return (
    <div className="h-full flex flex-col">
      {/* Compact header — run name (so the user sees which run they're
          inspecting) + status badge. The test case name is already shown in
          the page header above, so repeating it here would be redundant. */}
      <div className="px-4 py-2.5 border-b bg-card shrink-0">
        <div className="flex items-center gap-2">
          {badge.icon}
          <span
            className="text-sm font-semibold truncate flex-1"
            title={getRunDisplayName(report)}
          >
            {getRunDisplayName(report)}
          </span>
          <Badge className={`text-[9px] px-1.5 py-0 shrink-0 ${badge.cls}`}>
            {badge.label}
          </Badge>
        </div>
        {/* Secondary line: agent · model — mirrors the runs list so the
            user has the same execution context visible whether they're
            scanning the list or focused on a single run. */}
        <div className="text-[10px] text-muted-foreground mt-1 truncate">
          {report.agentName || '—'} · {report.modelName || '—'}
        </div>
      </div>

      {/* Reusable definition collapsible — same widget on both
          TestCaseDetailPage and RunInspectorPage so users get the
          identical right-pane experience whether they came from a
          test-case run or a benchmark run. Defaults closed; clicking
          the header opens it to show file path (SDK) or full JSON
          (no truncation). */}
      <CollapsibleTestCaseDefinition testCase={testCase} />

      {/* Tabs — directly into content, no extra chrome */}
      <div className="flex-1 overflow-hidden">
        <RunDetailsContent report={report} hideMetrics />
      </div>
    </div>
  );
};
