/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { GitBranch, Scale, Activity } from 'lucide-react';
import { EvaluationReport, BenchmarkRun } from '@/types';
import { TrajectorySection } from './sections/TrajectorySection';
import { JudgeSection } from './sections/JudgeSection';
import { TraceFlowComparison } from './sections/TraceFlowComparison';

interface UseCaseExpandedRowProps {
  useCaseId: string;
  runs: BenchmarkRun[];
  reports: Record<string, EvaluationReport>;
}

export const UseCaseExpandedRow: React.FC<UseCaseExpandedRowProps> = ({
  useCaseId,
  runs,
  reports,
}) => {
  return (
    <div className="p-4 bg-muted/20 border-t border-border">
      <Tabs defaultValue="trajectory" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="trajectory" className="gap-2">
            <GitBranch size={14} />
            Trajectory
          </TabsTrigger>
          <TabsTrigger value="traces" className="gap-2">
            <Activity size={14} />
            Traces
          </TabsTrigger>
          <TabsTrigger value="judge" className="gap-2">
            <Scale size={14} />
            LLM Judge
          </TabsTrigger>
        </TabsList>

        <TabsContent value="trajectory" className="mt-0">
          <TrajectorySection
            runs={runs}
            reports={reports}
            useCaseId={useCaseId}
          />
        </TabsContent>

        <TabsContent value="traces" className="mt-0">
          <TraceFlowComparison
            runs={runs}
            reports={reports}
            useCaseId={useCaseId}
          />
        </TabsContent>

        <TabsContent value="judge" className="mt-0">
          <JudgeSection
            runs={runs}
            reports={reports}
            useCaseId={useCaseId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
};
