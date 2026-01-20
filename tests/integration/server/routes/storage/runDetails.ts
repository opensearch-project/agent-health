/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for RunDetailsPage data loading
 *
 * These tests verify the API supports loading experiment runs in different states
 * for the RunDetailsPage component navigation.
 *
 * Run tests:
 *   npm test -- --testPathPattern=runDetails
 */

const BASE_URL = 'http://localhost:4001';

// Check if backend is available
const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/api/storage/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('RunDetailsPage Integration Tests', () => {
  let backendAvailable = false;
  let testExperimentId: string | null = null;
  let testCaseIds: string[] = [];
  let createdRunIds: string[] = [];

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn('Backend not available - skipping integration tests');
      console.warn('Start the backend with: npm run dev:server');
      return;
    }

    // Create test cases for the experiment
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${BASE_URL}/api/storage/test-cases`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `RunDetails Test Case ${i + 1}`,
          description: `Test case ${i + 1} for RunDetails integration tests`,
          category: 'Test',
          difficulty: 'Easy',
          labels: ['test', 'rundetails'],
          initialPrompt: `Test prompt ${i + 1}`,
          context: [],
          expectedOutcomes: ['Test completes'],
        }),
      });

      if (response.ok) {
        const testCase = await response.json();
        testCaseIds.push(testCase.id);
      }
    }

    // Create a test experiment with the test cases
    const experimentResponse = await fetch(`${BASE_URL}/api/storage/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'RunDetails Test Benchmark',
        description: 'Experiment for testing RunDetailsPage navigation',
        testCaseIds: testCaseIds,
        runs: [],
      }),
    });

    if (experimentResponse.ok) {
      const experiment = await experimentResponse.json();
      testExperimentId = experiment.id;
    }
  });

  afterAll(async () => {
    if (!backendAvailable) return;

    // Cleanup: delete created runs
    for (const runId of createdRunIds) {
      try {
        await fetch(`${BASE_URL}/api/storage/runs/${runId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Cleanup: delete test experiment
    if (testExperimentId) {
      try {
        await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Cleanup: delete test cases
    for (const testCaseId of testCaseIds) {
      try {
        await fetch(`${BASE_URL}/api/storage/test-cases/${testCaseId}`, {
          method: 'DELETE',
        });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Experiment with runs in different states', () => {
    it('should create experiment run with pending results', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length === 0) {
        console.warn('Skipping: backend not available or no test data');
        return;
      }

      // Create a run with all pending results
      const pendingRun = {
        id: `run-pending-${Date.now()}`,
        name: 'Pending Run',
        description: 'All test cases pending',
        createdAt: new Date().toISOString(),
        status: 'running',
        agentKey: 'mlcommons',
        modelId: 'claude-sonnet-4',
        results: {} as Record<string, { reportId: string; status: string }>,
      };

      // Add pending results for each test case
      testCaseIds.forEach(tcId => {
        pendingRun.results[tcId] = { reportId: '', status: 'pending' };
      });

      // Update experiment with the new run
      const response = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runs: [pendingRun],
        }),
      });

      expect(response.ok).toBe(true);

      // Fetch the experiment and verify the run
      const getResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      expect(getResponse.ok).toBe(true);

      const experiment = await getResponse.json();
      expect(experiment.runs).toHaveLength(1);
      expect(experiment.runs[0].status).toBe('running');
      expect(experiment.runs[0].results[testCaseIds[0]].status).toBe('pending');
    });

    it('should create experiment run with mixed states (pending, running, completed)', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length < 3) {
        console.warn('Skipping: backend not available or insufficient test cases');
        return;
      }

      // First, create a report for a completed test case
      const reportResponse = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId: testCaseIds[0],
          experimentId: testExperimentId,
          experimentRunId: `run-mixed-${Date.now()}`,
          agentName: 'ML Commons Agent',
          modelName: 'Claude Sonnet 4',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 85 },
          llmJudgeReasoning: 'Test passed',
        }),
      });

      expect(reportResponse.ok).toBe(true);
      const report = await reportResponse.json();
      createdRunIds.push(report.id);

      // Create a run with mixed states
      const mixedRun = {
        id: `run-mixed-${Date.now()}`,
        name: 'Mixed States Run',
        description: 'Test cases in different states',
        createdAt: new Date().toISOString(),
        status: 'running',
        agentKey: 'mlcommons',
        modelId: 'claude-sonnet-4',
        results: {
          [testCaseIds[0]]: { reportId: report.id, status: 'completed' },
          [testCaseIds[1]]: { reportId: '', status: 'running' },
          [testCaseIds[2]]: { reportId: '', status: 'pending' },
        },
      };

      // Update experiment with the mixed run
      const updateResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runs: [mixedRun],
        }),
      });

      expect(updateResponse.ok).toBe(true);

      // Fetch and verify
      const getResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      const experiment = await getResponse.json();

      expect(experiment.runs[0].results[testCaseIds[0]].status).toBe('completed');
      expect(experiment.runs[0].results[testCaseIds[1]].status).toBe('running');
      expect(experiment.runs[0].results[testCaseIds[2]].status).toBe('pending');
    });

    it('should create experiment run with failed status', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length === 0) {
        console.warn('Skipping: backend not available or no test data');
        return;
      }

      const failedRun = {
        id: `run-failed-${Date.now()}`,
        name: 'Failed Run',
        description: 'Run that failed',
        createdAt: new Date().toISOString(),
        status: 'failed',
        error: 'Agent connection timeout',
        agentKey: 'mlcommons',
        modelId: 'claude-sonnet-4',
        results: {
          [testCaseIds[0]]: { reportId: '', status: 'failed' },
        },
      };

      const response = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runs: [failedRun],
        }),
      });

      expect(response.ok).toBe(true);

      const getResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      const experiment = await getResponse.json();

      expect(experiment.runs[0].status).toBe('failed');
      expect(experiment.runs[0].error).toBe('Agent connection timeout');
      expect(experiment.runs[0].results[testCaseIds[0]].status).toBe('failed');
    });

    it('should create fully completed experiment run', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length < 2) {
        console.warn('Skipping: backend not available or insufficient test cases');
        return;
      }

      // Create reports for completed test cases
      const reports: string[] = [];
      for (let i = 0; i < 2; i++) {
        const reportResponse = await fetch(`${BASE_URL}/api/storage/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            testCaseId: testCaseIds[i],
            experimentId: testExperimentId,
            experimentRunId: `run-completed-${Date.now()}`,
            agentName: 'ML Commons Agent',
            modelName: 'Claude Sonnet 4',
            status: 'completed',
            passFailStatus: i === 0 ? 'passed' : 'failed',
            trajectory: [],
            metrics: { accuracy: i === 0 ? 95 : 45 },
            llmJudgeReasoning: i === 0 ? 'Test passed' : 'Test failed',
          }),
        });

        if (reportResponse.ok) {
          const report = await reportResponse.json();
          reports.push(report.id);
          createdRunIds.push(report.id);
        }
      }

      const completedRun = {
        id: `run-completed-${Date.now()}`,
        name: 'Completed Run',
        description: 'All test cases completed',
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'mlcommons',
        modelId: 'claude-sonnet-4',
        results: {
          [testCaseIds[0]]: { reportId: reports[0], status: 'completed' },
          [testCaseIds[1]]: { reportId: reports[1], status: 'completed' },
        },
      };

      const response = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runs: [completedRun],
        }),
      });

      expect(response.ok).toBe(true);

      const getResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      const experiment = await getResponse.json();

      expect(experiment.runs[0].status).toBe('completed');
      expect(experiment.runs[0].results[testCaseIds[0]].status).toBe('completed');
      expect(experiment.runs[0].results[testCaseIds[0]].reportId).toBe(reports[0]);
    });
  });

  describe('Fetching reports by experiment run', () => {
    it('should fetch reports for a specific experiment run', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length === 0) {
        console.warn('Skipping: backend not available or no test data');
        return;
      }

      const experimentRunId = `run-fetch-test-${Date.now()}`;

      // Create reports linked to an experiment run
      const reportResponse = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId: testCaseIds[0],
          experimentId: testExperimentId,
          experimentRunId: experimentRunId,
          agentName: 'ML Commons Agent',
          modelName: 'Claude Sonnet 4',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 90 },
          llmJudgeReasoning: 'Test passed',
        }),
      });

      expect(reportResponse.ok).toBe(true);
      const report = await reportResponse.json();
      createdRunIds.push(report.id);

      // Fetch reports by experiment run
      const fetchResponse = await fetch(
        `${BASE_URL}/api/storage/runs?experimentId=${testExperimentId}&experimentRunId=${experimentRunId}`
      );

      expect(fetchResponse.ok).toBe(true);
      const result = await fetchResponse.json();

      expect(result.runs).toBeDefined();
      expect(result.runs.length).toBeGreaterThan(0);
      expect(result.runs[0].experimentRunId).toBe(experimentRunId);
    });
  });

  describe('Navigation support - BenchmarkRun.id based routing', () => {
    it('should support navigation to pending run by BenchmarkRun.id', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length === 0) {
        console.warn('Skipping: backend not available or no test data');
        return;
      }

      const runId = `nav-pending-${Date.now()}`;

      // Create experiment with a pending run (no reportIds)
      const pendingRun = {
        id: runId,
        name: 'Navigation Test - Pending',
        createdAt: new Date().toISOString(),
        status: 'running',
        agentKey: 'mlcommons',
        modelId: 'claude-sonnet-4',
        results: {
          [testCaseIds[0]]: { reportId: '', status: 'pending' },
        },
      };

      await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs: [pendingRun] }),
      });

      // Simulate what RunDetailsPage does: fetch experiment, find run by ID
      const getResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      const experiment = await getResponse.json();

      const foundRun = experiment.runs.find((r: any) => r.id === runId);
      expect(foundRun).toBeDefined();
      expect(foundRun.id).toBe(runId);
      expect(foundRun.status).toBe('running');

      // Verify run has no reportIds (all pending)
      const hasReportIds = Object.values(foundRun.results).some((r: any) => r.reportId);
      expect(hasReportIds).toBe(false);
    });

    it('should support navigation to completed run by BenchmarkRun.id', async () => {
      if (!backendAvailable || !testExperimentId || testCaseIds.length === 0) {
        console.warn('Skipping: backend not available or no test data');
        return;
      }

      const runId = `nav-completed-${Date.now()}`;

      // Create a report first
      const reportResponse = await fetch(`${BASE_URL}/api/storage/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testCaseId: testCaseIds[0],
          experimentId: testExperimentId,
          experimentRunId: runId,
          agentName: 'ML Commons Agent',
          modelName: 'Claude Sonnet 4',
          status: 'completed',
          passFailStatus: 'passed',
          trajectory: [],
          metrics: { accuracy: 88 },
          llmJudgeReasoning: 'Test passed',
        }),
      });

      const report = await reportResponse.json();
      createdRunIds.push(report.id);

      // Create completed run
      const completedRun = {
        id: runId,
        name: 'Navigation Test - Completed',
        createdAt: new Date().toISOString(),
        status: 'completed',
        agentKey: 'mlcommons',
        modelId: 'claude-sonnet-4',
        results: {
          [testCaseIds[0]]: { reportId: report.id, status: 'completed' },
        },
      };

      await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runs: [completedRun] }),
      });

      // Simulate RunDetailsPage navigation
      const getResponse = await fetch(`${BASE_URL}/api/storage/experiments/${testExperimentId}`);
      const experiment = await getResponse.json();

      const foundRun = experiment.runs.find((r: any) => r.id === runId);
      expect(foundRun).toBeDefined();
      expect(foundRun.status).toBe('completed');

      // Fetch reports for this run
      const reportsResponse = await fetch(
        `${BASE_URL}/api/storage/runs?experimentId=${testExperimentId}&experimentRunId=${runId}`
      );
      const reportsResult = await reportsResponse.json();

      expect(reportsResult.runs.length).toBeGreaterThan(0);
      expect(reportsResult.runs[0].id).toBe(report.id);
    });
  });
});
