/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useParams, useLocation, generatePath } from 'react-router-dom';
import { refreshConfig, subscribeConfigChange } from '@/lib/constants';
import { initializeTheme } from '@/lib/theme';
import { ENV_CONFIG } from '@/lib/config';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { SettingsPage } from './components/SettingsPage';
import { ComparisonPage } from './components/comparison/ComparisonPage';
import { AgentTracesPage } from './components/traces/AgentTracesPage';
import { PerformanceOverlay } from './components/PerformanceOverlay';
import { CodingAgentsPage } from './components/codingAgents/CodingAgentsPage';
import { EvaluatorsPage } from './components/EvaluatorsPage';
import { EvaluatorEditPage } from './components/EvaluatorEditPage';
import { AssistantChat } from './components/assistant-ui/AssistantChat';
import { SkillsPage } from './components/skills/SkillsPage';

// Evals 3 — Evaluations
import { BenchmarksPage4 as Evals3Benchmarks } from './components/evals3/BenchmarksPage';
import { TestCasesPage4 as Evals3TestCases } from './components/evals3/TestCasesPage';
import { BenchmarkRunsPage2 as Evals3BenchmarkRuns } from './components/evals3/BenchmarkRunsPage';
import { TestCaseDetailPage as Evals3TestCaseDetail } from './components/evals3/TestCaseDetailPage';
import { EvalRunsPage as Evals3EvalRuns } from './components/evals3/EvalRunsPage';
import { RunInspectorPage as Evals3RunInspector } from './components/evals3/RunInspectorPage';
import { NewRunPage as Evals3NewRun } from './components/evals3/NewRunPage';
import { ReportRedirect } from './components/ReportRedirect';
import { legacyRouteRedirects } from '@/lib/legacyRouteRedirects';

/**
 * `<Navigate replace>` to the evals3 twin of a retired route, carrying the
 * matched params and the query string over. One component for every row of
 * `legacyRouteRedirects` (lib/legacyRouteRedirects.ts) so the table is the
 * single place a redirect is defined.
 */
function LegacyRedirect({ to }: { to: string }) {
  const params = useParams();
  const { search } = useLocation();
  return <Navigate to={`${generatePath(to, params)}${search}`} replace />;
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

/**
 * The application's route table. Exported (without the BrowserRouter / Layout
 * shell) so tests can mount it under a MemoryRouter and assert where each
 * URL — in particular every retired legacy URL — actually lands.
 */
export function AppRoutes() {
  return (
    <Routes>
      {/* Primary routes */}
      <Route path="/" element={<Dashboard />} />
      <Route path="/evaluators" element={<EvaluatorsPage />} />
      <Route path="/evaluators/new" element={<EvaluatorEditPage />} />
      <Route path="/evaluators/:evaluatorId" element={<EvaluatorEditPage />} />
      <Route path="/evaluators/:evaluatorId/edit" element={<EvaluatorEditPage />} />

      {/* Settings */}
      <Route path="/settings" element={<SettingsPage />} />

      {/* Comparison */}
      <Route path="/compare" element={<ComparisonPage />} />
      <Route path="/compare/:benchmarkId" element={<ComparisonPage />} />

      {/* Agent Traces - Table View */}
      <Route path="/agent-traces" element={<AgentTracesPage />} />

      {/* Evaluations (evals3) — the only benchmark / test-case / run UI */}
      <Route path="/evaluations/benchmarks" element={<Evals3Benchmarks />} />
      <Route path="/evaluations/test-cases" element={<Evals3TestCases />} />
      <Route path="/evaluations/test-cases/:testCaseId" element={<Evals3TestCaseDetail />} />
      <Route path="/evaluations/runs" element={<Evals3EvalRuns />} />
      <Route path="/evaluations/runs/new" element={<Evals3NewRun />} />
      <Route path="/evaluations/runs/:runId/inspect" element={<Evals3RunInspector />} />
      <Route path="/evaluations/benchmarks/:benchmarkId" element={<Evals3BenchmarkRuns />} />
      <Route path="/evaluations/benchmarks/:benchmarkId/cases/:caseId" element={<Evals3BenchmarkRuns />} />
      <Route path="/evaluations/benchmarks/:benchmarkId/runs" element={<Evals3BenchmarkRuns />} />
      <Route path="/evaluations/benchmarks/:benchmarkId/runs/:runId" element={<Navigate to="inspect" replace />} />
      <Route path="/evaluations/benchmarks/:benchmarkId/runs/:runId/inspect" element={<Evals3RunInspector />} />

      {/* Skills Evaluator */}
      <Route path="/skills" element={<SkillsPage />} />

      {/* Coding Agent Analytics */}
      <Route path="/coding-agents" element={<CodingAgentsPage />} />

      {/* AI Assistant */}
      <Route path="/assistant" element={<AssistantChat />} />

      {/* Retired pre-evals3 pages and the older evals3 run-detail page:
          every one redirects to its evals3 twin (lib/legacyRouteRedirects.ts). */}
      {legacyRouteRedirects.map(({ pattern, to }) => (
        <Route key={pattern} path={pattern} element={<LegacyRedirect to={to} />} />
      ))}
      {/* `/runs/:runId` took a REPORT id — resolve it to the run inspector
          (or the test case's detail page) after a lookup. */}
      <Route path="/runs/:runId" element={<ReportRedirect />} />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
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
          <AppRoutes />
        </Layout>
      </Router>
      <PerformanceOverlay />
    </>
  );
}

export default App;