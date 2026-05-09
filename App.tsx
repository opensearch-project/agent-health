/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom';
import { refreshConfig, subscribeConfigChange } from '@/lib/constants';
import { initializeTheme } from '@/lib/theme';
import { ENV_CONFIG } from '@/lib/config';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { BenchmarksPage } from './components/BenchmarksPage';
import { SettingsPage } from './components/SettingsPage';
import { BenchmarkRunsPage } from './components/BenchmarkRunsPage';
import { RunDetailsPage } from './components/RunDetailsPage';
import { TestCasesPage } from './components/TestCasesPage';
import { TestCaseRunsPage } from './components/TestCaseRunsPage';
import { ComparisonPage } from './components/comparison/ComparisonPage';
import { TracesPage } from './components/traces/TracesPage';
import { AgentTracesPage } from './components/traces/AgentTracesPage';
import { PerformanceOverlay } from './components/PerformanceOverlay';
import { CodingAgentsPage } from './components/codingAgents/CodingAgentsPage';
import { EvaluatorsPage } from './components/EvaluatorsPage';
import { EvaluatorEditPage } from './components/EvaluatorEditPage';
import { AssistantChat } from './components/assistant-ui/AssistantChat';

// Evals 3 — Evaluations
import { BenchmarksPage4 as Evals3Benchmarks } from './components/evals3/BenchmarksPage';
import { TestCasesPage4 as Evals3TestCases } from './components/evals3/TestCasesPage';
import { BenchmarkRunsPage2 as Evals3BenchmarkRuns } from './components/evals3/BenchmarkRunsPage';
import { TestCaseDetailPage as Evals3TestCaseDetail } from './components/evals3/TestCaseDetailPage';
import { EvalRunsPage as Evals3EvalRuns } from './components/evals3/EvalRunsPage';
import { RunInspectorPage as Evals3RunInspector } from './components/evals3/RunInspectorPage';

function ExperimentRunsRedirect() {
  const { experimentId } = useParams();
  return <Navigate to={`/benchmarks/${experimentId}/runs`} replace />;
}

/**
 * Sync debug state from server to localStorage cache
 * Keeps browser cache in sync with agent-health.config.json (single source of truth)
 */
function DebugStateSync() {
  const location = useLocation();

  // Helper function to sync debug state
  const syncDebugState = () => {
    fetch(`${ENV_CONFIG.backendUrl}/api/debug`)
      .then(res => res.json())
      .then(data => {
        localStorage.setItem('agenteval_debug', String(data.enabled));
      })
      .catch(() => {
        // Silently fail - debug sync is non-critical
      });
  };

  // Sync on route change (catches page navigation)
  useEffect(() => {
    syncDebugState();
  }, [location.pathname]);

  // Sync when tab becomes visible (catches when user switches back)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        syncDebugState();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return null; // This component doesn't render anything
}

function App() {
  // Initialize theme on mount
  useEffect(() => {
    initializeTheme();
  }, []);

  // Fetch server config on mount so custom agents/models appear in the UI.
  // Subscribe to config changes so that any later refreshConfig() call
  // (e.g., from SettingsPage after adding a custom endpoint) re-renders
  // the entire tree, making updated agents visible in all dropdowns.
  const [, setConfigVersion] = useState(0);
  useEffect(() => {
    refreshConfig();
    return subscribeConfigChange(() => setConfigVersion(v => v + 1));
  }, []);

  return (
    <>
      <Router>
        <DebugStateSync />
        <Layout>
          <Routes>
            {/* Primary routes */}
            <Route path="/" element={<Dashboard />} />
            <Route path="/test-cases" element={<TestCasesPage />} />
            <Route path="/test-cases/:testCaseId/runs" element={<TestCaseRunsPage />} />
            <Route path="/benchmarks" element={<BenchmarksPage />} />
            <Route path="/benchmarks/:benchmarkId/runs" element={<BenchmarkRunsPage />} />
            <Route path="/evaluators" element={<EvaluatorsPage />} />
            <Route path="/evaluators/new" element={<EvaluatorEditPage />} />
            <Route path="/evaluators/:evaluatorId/edit" element={<EvaluatorEditPage />} />

            {/* Unified run details page - works for both test case and benchmark runs */}
            <Route path="/runs/:runId" element={<RunDetailsPage />} />

            {/* Backwards compatibility - redirect old benchmark run route to new unified route */}
            <Route path="/benchmarks/:benchmarkId/runs/:runId" element={<RunDetailsPage />} />

            {/* Settings */}
            <Route path="/settings" element={<SettingsPage />} />

            {/* Comparison */}
            <Route path="/compare" element={<ComparisonPage />} />
            <Route path="/compare/:benchmarkId" element={<ComparisonPage />} />

            {/* Live Traces */}
            <Route path="/traces" element={<TracesPage />} />

            {/* Agent Traces - Table View */}
            <Route path="/agent-traces" element={<AgentTracesPage />} />

            {/* Evals 3 → Evaluations */}
            <Route path="/evaluations/benchmarks" element={<Evals3Benchmarks />} />
            <Route path="/evaluations/test-cases" element={<Evals3TestCases />} />
            <Route path="/evaluations/test-cases/:testCaseId" element={<Evals3TestCaseDetail />} />
            <Route path="/evaluations/runs" element={<Evals3EvalRuns />} />
            <Route path="/evaluations/benchmarks/:benchmarkId/runs" element={<Evals3BenchmarkRuns />} />
            <Route path="/evaluations/benchmarks/:benchmarkId/runs/:runId" element={<Navigate to="inspect" replace />} />
            <Route path="/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect" element={<Evals3RunInspector />} />

            {/* Coding Agent Analytics */}
            <Route path="/coding-agents" element={<CodingAgentsPage />} />

            {/* AI Assistant */}
            <Route path="/assistant" element={<AssistantChat />} />
            {/* Redirects for deprecated routes */}
            <Route path="/evals" element={<Navigate to="/test-cases" replace />} />
            <Route path="/run" element={<Navigate to="/test-cases" replace />} />
            <Route path="/reports" element={<Navigate to="/benchmarks" replace />} />
            <Route path="/experiments" element={<Navigate to="/benchmarks" replace />} />
            <Route path="/experiments/:experimentId/runs" element={<ExperimentRunsRedirect />} />

            {/* Catch-all: redirect unknown sub-paths to their parent list pages */}
            <Route path="/benchmarks/*" element={<Navigate to="/benchmarks" replace />} />
            <Route path="/test-cases/*" element={<Navigate to="/test-cases" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </Router>
      <PerformanceOverlay />
    </>
  );
}

export default App;