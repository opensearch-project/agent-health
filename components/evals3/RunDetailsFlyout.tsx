/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * RunDetailsFlyout — Evals 3: Test Case Run detail flyout
 *
 * Slides in from the right (same pattern as TraceFlyoutContent in Agent Traces).
 * Shows RunDetailsContent inside a resizable flyout panel.
 * Triggered from BenchmarkRunDetailPage when clicking a test case result row.
 */

import React from 'react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import { EvaluationReport, TestCase } from '@/types';
import { TestCaseInspectorPanel } from './TestCaseInspectorPanel';

type ResultStatus = 'passed' | 'failed' | 'errored' | 'running' | 'pending';

function getResultStatus(report: EvaluationReport): ResultStatus {
  // Issue #242: an evaluator-error report has `metricsStatus: 'error'` and
  // `passFailStatus: null`. Light up the amber `ERRORED` chip on the
  // flyout pill instead of conflating with `'failed'`.
  if (report.metricsStatus === 'error') return 'errored';
  if (report.passFailStatus === 'passed') return 'passed';
  if (report.passFailStatus === 'failed') return 'failed';
  if (report.status === 'running') return 'running';
  return 'pending';
}

interface RunDetailsFlyoutProps {
  report: EvaluationReport;
  testCase: TestCase | null;
  onClose: () => void;
}

export const RunDetailsFlyout: React.FC<RunDetailsFlyoutProps> = ({
  report,
  testCase,
  onClose,
}) => {
  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <ResizablePanelGroup direction="horizontal" className="h-full pointer-events-none">
        {/* Left invisible panel — click-through to page below */}
        <ResizablePanel
          defaultSize={30}
          minSize={5}
          maxSize={60}
          className="pointer-events-none"
          onClick={onClose}
        />

        <ResizableHandle withHandle className="pointer-events-auto" />

        {/* Right panel — flyout content */}
        <ResizablePanel
          defaultSize={70}
          minSize={40}
          maxSize={95}
          className="bg-background border-l shadow-2xl pointer-events-auto"
        >
          <div className="h-full flex flex-col">
            {/* ── Body — TestCaseInspectorPanel ───────────────────── */}
            <div className="flex-1 overflow-hidden">
              <TestCaseInspectorPanel
                report={report}
                testCase={testCase}
                status={getResultStatus(report)}
              />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
