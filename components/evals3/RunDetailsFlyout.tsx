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
import { getResultStatus } from './ResultStatus';

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
                status={getResultStatus({ status: report.status }, report)}
              />
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
};
