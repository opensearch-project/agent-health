/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `agent-health benchmark` — the `Model:` line (#612, problem 7).
 *
 * With no model configured on the agent the CLI printed the FIRST key of the
 * built-in model catalog, which is `demo-model`, so a REST agent whose model is
 * decided on the agent side showed `Model: demo-model` and users read it as
 * "the mock judge is on". The CLI prints the model the agent declares in its
 * own connector config, or `—` when it declares none — never a catalog entry
 * the agent was not configured with.
 *
 * Two levels: the pure label helper, and the real `benchmark` command driven
 * through its unified (evaluation-runs) path with the server mocked at the
 * HTTP boundary, asserting what is actually printed.
 */

import type { AgentConfig } from '@/types/index.js';

jest.mock('@/lib/config/index.js', () => ({
  __esModule: true,
  loadConfig: jest.fn(),
  DEFAULT_SERVER_CONFIG: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
}));

jest.mock('@/cli/utils/serverLifecycle.js', () => ({
  __esModule: true,
  ensureServer: jest.fn(),
  createServerCleanup: jest.fn(),
  isServerRunning: jest.fn(),
}));

jest.mock('@/cli/utils/apiClient.js', () => ({
  __esModule: true,
  ApiClient: jest.fn(),
  ServerError: class ServerError extends Error {},
}));

jest.mock('chalk', () => {
  const identity = (value: string) => value;
  const chalk = { cyan: identity, green: identity, yellow: identity, red: identity, gray: identity, bold: identity };
  return { __esModule: true, default: chalk, ...chalk };
});

jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn(() => {
    const spinner: any = { text: '' };
    for (const m of ['start', 'succeed', 'fail', 'warn', 'info', 'stop']) spinner[m] = jest.fn(() => spinner);
    return spinner;
  }),
}));

import { loadConfig } from '@/lib/config/index.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import { createServerCleanup, ensureServer, isServerRunning } from '@/cli/utils/serverLifecycle.js';
import { createBenchmarkCommand, formatAgentModelLabel, NO_AGENT_MODEL_LABEL } from '@/cli/commands/benchmark.js';

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockEnsureServer = ensureServer as jest.MockedFunction<typeof ensureServer>;
const mockCreateServerCleanup = createServerCleanup as jest.MockedFunction<typeof createServerCleanup>;
const mockIsServerRunning = isServerRunning as jest.MockedFunction<typeof isServerRunning>;
const MockApiClientClass = ApiClient as unknown as jest.Mock;

const REST_AGENT_NO_MODEL: AgentConfig = {
  key: 'rest-no-model',
  name: 'REST agent (no model)',
  endpoint: 'http://127.0.0.1:1/ask',
  connectorType: 'rest',
  enabled: true,
};
const REST_AGENT_WITH_MODEL: AgentConfig = {
  key: 'rest-with-model',
  name: 'REST agent (declared model)',
  endpoint: 'http://127.0.0.1:1/ask',
  connectorType: 'rest',
  connectorConfig: { model: 'provider.deployment-v2' },
  enabled: true,
};

/** The built-in catalog's first entry is the demo (mock) model. */
const CATALOG = {
  'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo Model', provider: 'demo', context_window: 1, max_output_tokens: 1 },
  'claude-sonnet-4.5': { model_id: 'us.anthropic.claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', provider: 'bedrock', context_window: 1, max_output_tokens: 1 },
};

describe('formatAgentModelLabel', () => {
  it('prints the model the agent declares in its own connector config', () => {
    expect(formatAgentModelLabel(REST_AGENT_WITH_MODEL)).toBe('provider.deployment-v2');
    expect(formatAgentModelLabel({ ...REST_AGENT_NO_MODEL, connectorType: 'claude-code', connectorConfig: { env: { ANTHROPIC_MODEL: 'm-env' } } })).toBe('m-env');
    expect(formatAgentModelLabel({ ...REST_AGENT_NO_MODEL, connectorType: 'pi', connectorConfig: { args: ['--model', 'm-arg'] } })).toBe('m-arg');
  });

  it('prints — (never a catalog entry) when the agent declares no model', () => {
    expect(NO_AGENT_MODEL_LABEL).toBe('—');
    expect(formatAgentModelLabel(REST_AGENT_NO_MODEL)).toBe('—');
    expect(formatAgentModelLabel({ ...REST_AGENT_NO_MODEL, connectorConfig: { model: '' } })).toBe('—');
    expect(formatAgentModelLabel(undefined)).toBe('—');
  });
});

describe('benchmark command (unified path) — printed Model line', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let postedBodies: any[];
  const originalFetch = global.fetch;

  /** Server mocked at the HTTP boundary: an SSE stream that starts and completes one case. */
  function mockEvaluationRunsEndpoint() {
    postedBodies = [];
    const sse = [
      `data: ${JSON.stringify({ runId: 'eval-run-1', testCases: [{ id: 'tc-1', name: 'case 1', status: 'pending' }] })}\n\n`,
      `data: ${JSON.stringify({ completedCount: 1, totalTestCases: 1 })}\n\n`,
      `data: ${JSON.stringify({ status: 'completed' })}\n\n`,
    ].join('');
    global.fetch = jest.fn(async (_url: any, init?: any) => {
      postedBodies.push(JSON.parse(init?.body ?? '{}'));
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as any;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfig.mockResolvedValue({
      server: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
      agents: [REST_AGENT_NO_MODEL, REST_AGENT_WITH_MODEL],
      models: CATALOG,
      connectors: [], testCases: [], reporters: [], judge: {}, telemetry: {},
    } as any);
    mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4001', wasStarted: false } as any);
    mockCreateServerCleanup.mockReturnValue(jest.fn());
    mockIsServerRunning.mockResolvedValue(true);
    MockApiClientClass.mockImplementation(() => ({
      findBenchmark: jest.fn().mockResolvedValue(null),
      getBenchmark: jest.fn().mockResolvedValue(null),
      getConfigStatus: jest.fn().mockResolvedValue({}),
      getTestCaseSummaries: jest.fn().mockResolvedValue([]),
      getEvaluationRun: jest.fn().mockResolvedValue({
        id: 'eval-run-1', status: 'completed',
        results: { 'tc-1': { reportId: 'rep-1', status: 'completed', passFailStatus: 'passed' } },
      }),
    }));
    mockEvaluationRunsEndpoint();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    delete process.env.CI;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    global.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  const printed = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
  const run = (args: string[]) => createBenchmarkCommand().parseAsync(['node', 'benchmark', ...args]);

  it('REST agent without a model → `Model: —`, not the catalog\'s first entry (demo-model)', async () => {
    await run(['-t', 'tc-1', '-a', 'rest-no-model']);
    const out = printed();
    expect(out).toContain('  Model: —');
    expect(out).not.toContain('Model: demo-model');
    expect(out).not.toMatch(/Model: .*mock/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('REST agent with a declared model → prints that model', async () => {
    await run(['-t', 'tc-1', '-a', 'rest-with-model']);
    expect(printed()).toContain('  Model: provider.deployment-v2');
    // The declared model is also what the run request carries.
    expect(postedBodies[0]).toMatchObject({ agentKey: 'rest-with-model', modelId: 'provider.deployment-v2' });
  });
});
