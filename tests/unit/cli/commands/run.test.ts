/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `run` command: verdict label + exit code for errored (not judged) reports.
 * Sibling of the `benchmark` fix — a report with no verdict (agent request
 * rejected / judge could not run) is ERRORED, never a FAILED verdict, and the
 * command exits 1 for it; a FAILED verdict keeps exit 0.
 */

jest.mock('chalk', () => {
  const identity = (value: string) => value;
  const chalk = { cyan: identity, green: identity, yellow: identity, red: identity, gray: identity, bold: identity };
  return { __esModule: true, default: chalk, ...chalk };
});
jest.mock('ora', () => ({ __esModule: true, default: jest.fn(() => ({ start: jest.fn() })) }));
jest.mock('@/lib/config/index.js', () => ({ __esModule: true, loadConfig: jest.fn() }));
jest.mock('@/cli/utils/serverLifecycle.js', () => ({ __esModule: true, ensureServer: jest.fn(), createServerCleanup: jest.fn() }));
jest.mock('@/cli/utils/apiClient.js', () => ({ __esModule: true, ApiClient: jest.fn() }));
jest.mock('@/services/connectors/server.js', () => ({ __esModule: true, connectorRegistry: { register: jest.fn() } }));

import { verdictLabel, exitCodeForRunResults, buildResultRows } from '@/cli/commands/run';
import type { AgentConfig } from '@/types/index.js';

const agent = { key: 'stub', name: 'Stub Agent' } as AgentConfig;
const base = { id: 'report-1', trajectorySteps: 0 };

describe('verdictLabel', () => {
  it('labels judge verdicts PASSED / FAILED', () => {
    expect(verdictLabel({ status: 'completed', passFailStatus: 'passed', metricsStatus: 'ready' })).toBe('PASSED');
    expect(verdictLabel({ status: 'completed', passFailStatus: 'failed' })).toBe('FAILED');
  });

  it('labels a trace-mode judge that has not run yet PENDING', () => {
    expect(verdictLabel({ status: 'completed', metricsStatus: 'pending' })).toBe('PENDING');
    expect(verdictLabel({ status: 'completed', metricsStatus: 'calculating' })).toBe('PENDING');
  });

  it('labels an agent-request failure (status failed, metricsStatus error, no verdict) ERRORED — not the raw "failed"', () => {
    expect(verdictLabel({ status: 'failed', metricsStatus: 'error' })).toBe('ERRORED');
  });

  it('labels a completed report with no verdict and no pending judge ERRORED', () => {
    expect(verdictLabel({ status: 'completed' })).toBe('ERRORED');
    expect(verdictLabel({ status: 'completed', passFailStatus: 'passed', metricsStatus: 'error' })).toBe('ERRORED');
  });

  it('never shows PASSED / FAILED / PENDING for a report whose execution did not complete (stale verdict, cancelled, running)', () => {
    expect(verdictLabel({ status: 'failed', passFailStatus: 'passed' })).toBe('ERRORED');
    expect(verdictLabel({ status: 'cancelled', passFailStatus: 'failed' })).toBe('ERRORED');
    expect(verdictLabel({ status: 'running', metricsStatus: 'pending' })).toBe('ERRORED');
  });
});

describe('exitCodeForRunResults', () => {
  it('exits 1 when any agent errored (no report, or report without a verdict)', () => {
    expect(exitCodeForRunResults([{ report: null }])).toBe(1);
    expect(exitCodeForRunResults([
      { report: { status: 'completed', passFailStatus: 'passed' } },
      { report: { status: 'failed', metricsStatus: 'error' } },
    ])).toBe(1);
  });

  it('exits 0 for judged verdicts (including FAILED) and for a PENDING trace-mode judge', () => {
    expect(exitCodeForRunResults([
      { report: { status: 'completed', passFailStatus: 'passed' } },
      { report: { status: 'completed', passFailStatus: 'failed' } },
      { report: { status: 'completed', metricsStatus: 'pending' } },
    ])).toBe(0);
  });
});

describe('buildResultRows', () => {
  it('renders ERRORED (not "failed") for an agent-request failure and ERROR when no report came back', () => {
    const rows = buildResultRows([
      { agent, report: { ...base, status: 'failed', metricsStatus: 'error' } },
      { agent, report: null },
      { agent, report: { ...base, status: 'completed', passFailStatus: 'failed' } },
    ]);
    expect(rows.map(r => r[1])).toEqual(['ERRORED', 'ERROR', 'FAILED']);
  });
});
