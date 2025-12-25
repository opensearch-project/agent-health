import React from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ExperimentsPage } from './components/ExperimentsPage';
import { ConfigEditor } from './components/ConfigEditor';
import { SettingsPage } from './components/SettingsPage';
import { ExperimentRunsPage } from './components/ExperimentRunsPage';
import { RunDetailsPage } from './components/RunDetailsPage';
import { TestCasesPage } from './components/TestCasesPage';
import { TestCaseRunsPage } from './components/TestCaseRunsPage';
import { ComparisonPage } from './components/comparison/ComparisonPage';
import { TracesPage } from './components/traces/TracesPage';

function App() {
  return (
    <Router>
      <Layout>
        <Routes>
          {/* Primary routes */}
          <Route path="/" element={<Dashboard />} />
          <Route path="/test-cases" element={<TestCasesPage />} />
          <Route path="/test-cases/:testCaseId/runs" element={<TestCaseRunsPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/experiments/:experimentId/runs" element={<ExperimentRunsPage />} />

          {/* Unified run details page - works for both test case and experiment runs */}
          <Route path="/runs/:runId" element={<RunDetailsPage />} />

          {/* Backwards compatibility - redirect old experiment run route to new unified route */}
          <Route path="/experiments/:experimentId/runs/:runId" element={<RunDetailsPage />} />

          {/* Settings */}
          <Route path="/config" element={<ConfigEditor />} />
          <Route path="/settings" element={<SettingsPage />} />

          {/* Comparison */}
          <Route path="/compare/:experimentId" element={<ComparisonPage />} />

          {/* Live Traces */}
          <Route path="/traces" element={<TracesPage />} />

          {/* Redirects for deprecated routes */}
          <Route path="/evals" element={<Navigate to="/test-cases" replace />} />
          <Route path="/run" element={<Navigate to="/test-cases" replace />} />
          <Route path="/reports" element={<Navigate to="/experiments" replace />} />

          {/* Catch-all */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </Router>
  );
}

export default App;