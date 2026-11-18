/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * #620's source guard on the LOCAL execution path (#612 step 3).
 *
 * The guard used to act inside the SSE loop of the unified mode: at the
 * `started` event it printed what `--force` added and recorded the added
 * file on the benchmark description. The unified mode now executes through
 * `executeRunLocally`; the same two effects must happen from its `onStarted`
 * callback — awaited, once the server has linked the run's cases — and the
 * refusal must still happen BEFORE anything executes. The local executor is
 * mocked at its boundary; the guard, the command and the messages are real.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import type { Benchmark } from '@/types/index.js';

jest.mock('@/lib/config/index.js', () => ({
  __esModule: true,
  loadConfig: jest.fn(),
  DEFAULT_SERVER_CONFIG: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
}));
jest.mock('@/cli/utils/localExecutor.js', () => ({ __esModule: true, executeRunLocally: jest.fn(), LocalRunFailure: class LocalRunFailure extends Error {} }));
jest.mock('@/cli/utils/serverLifecycle.js', () => ({ __esModule: true, ensureServer: jest.fn(), createServerCleanup: jest.fn(), isServerRunning: jest.fn() }));
jest.mock('@/cli/utils/apiClient.js', () => ({ __esModule: true, ApiClient: jest.fn(), ServerError: class ServerError extends Error {} }));
jest.mock('chalk', () => {
  const identity = (value: string) => value;
  const chalk = { cyan: identity, green: identity, yellow: identity, red: identity, gray: identity, bold: identity };
  return { __esModule: true, default: chalk, ...chalk };
});
const spinnerLines: string[] = [];
jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn(() => {
    const spinner: any = { text: '' };
    for (const m of ['start', 'succeed', 'fail', 'warn', 'info', 'stop']) spinner[m] = jest.fn(() => spinner);
    spinner.stopAndPersist = jest.fn(({ text }: { text: string }) => { spinnerLines.push(text); return spinner; });
    return spinner;
  }),
}));

import { loadConfig } from '@/lib/config/index.js';
import { ApiClient } from '@/cli/utils/apiClient.js';
import { createServerCleanup, ensureServer, isServerRunning } from '@/cli/utils/serverLifecycle.js';
import { executeRunLocally } from '@/cli/utils/localExecutor.js';
import { createBenchmarkCommand } from '@/cli/commands/benchmark.js';

const mockLoadConfig = loadConfig as jest.MockedFunction<typeof loadConfig>;
const mockExecuteRunLocally = executeRunLocally as jest.MockedFunction<typeof executeRunLocally>;
const MockApiClientClass = ApiClient as unknown as jest.Mock;

describe('benchmark -f other.eval.js -n <existing> on the local execution path (#620 × #612)', () => {
  let tmp: string;
  let fileB: string;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let api: Record<string, jest.Mock>;
  let cleanup: jest.Mock;
  const existing: Benchmark = {
    id: 'bench-shop', name: 'shop', description: 'CLI benchmark run from a.eval.js', createdAt: 't', updatedAt: 't',
    currentVersion: 1, versions: [{ version: 1, createdAt: 't', testCaseIds: ['tc-a1', 'tc-a2'] }], testCaseIds: ['tc-a1', 'tc-a2'], runs: [],
  } as unknown as Benchmark;

  beforeEach(() => {
    jest.clearAllMocks();
    spinnerLines.length = 0;
    tmp = mkdtempSync(path.join(tmpdir(), 'ah-guard-local-'));
    fileB = path.join(tmp, 'b.eval.js');
    writeFileSync(fileB, "const { test } = require('@opensearch-project/agent-health'); test('b1', () => {});\n");
    mockLoadConfig.mockResolvedValue({
      server: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
      agents: [{ key: 'demo', name: 'Demo', connectorType: 'mock', endpoint: 'mock://demo', enabled: true }],
      models: { 'demo-model': { model_id: 'mock://demo-model', display_name: 'Demo', provider: 'demo', context_window: 1, max_output_tokens: 1 } },
      connectors: [], testCases: [], reporters: [], judge: {}, telemetry: {},
    } as any);
    (ensureServer as jest.Mock).mockResolvedValue({ baseUrl: 'http://localhost:4001', wasStarted: false });
    cleanup = jest.fn();
    (createServerCleanup as jest.Mock).mockReturnValue(cleanup);
    (isServerRunning as jest.Mock).mockResolvedValue(true);
    api = {
      findBenchmark: jest.fn().mockResolvedValue(existing),
      getConfigStatus: jest.fn().mockResolvedValue({ evalRoots: { roots: [tmp], source: 'default' } }),
      getTestCaseSummaries: jest.fn().mockResolvedValue([{ id: 'tc-a1', name: 'a1', sourceFile: 'a.eval.js' }, { id: 'tc-a2', name: 'a2', sourceFile: 'a.eval.js' }]),
      patchBenchmarkMetadata: jest.fn().mockResolvedValue(existing),
      createBenchmark: jest.fn(),
    };
    MockApiClientClass.mockImplementation(() => api);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code ?? 0})`); }) as never);
    delete process.env.CI;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
    logSpy.mockRestore(); errorSpy.mockRestore(); exitSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  const printed = () => [...logSpy.mock.calls, ...errorSpy.mock.calls].map((c) => c.map(String).join(' ')).join('\n');
  const run = (args: string[]) => createBenchmarkCommand().parseAsync(['node', 'benchmark', ...args]);

  it('without --force the run is refused BEFORE the local executor is invoked (exit 1, both files named, cleanup ran)', async () => {
    await expect(run(['-f', fileB, '-a', 'demo', '-n', 'shop', '--judge-model', 'demo-model'])).rejects.toThrow('process.exit(1)');
    const out = printed();
    expect(out).toMatch(/Error: benchmark "shop" was created from "a\.eval\.js"; ".*b\.eval\.js" is a different source file\./);
    expect(out).toMatch(/pass --force to add/);
    expect(mockExecuteRunLocally).not.toHaveBeenCalled();
    expect(api.patchBenchmarkMetadata).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  it('with --force: the warning is printed, and at onStarted (cases linked by the server) the CLI prints what was added and records the file on the description — then the run proceeds', async () => {
    const order: string[] = [];
    api.patchBenchmarkMetadata.mockImplementation(async () => { order.push('patch'); return existing; });
    mockExecuteRunLocally.mockImplementation(async ({ request, callbacks }) => {
      expect(request.benchmarkId).toBe('bench-shop');
      const testCases = [{ id: 'tc-b1', version: 1, name: 'b1' }];
      // The executor awaits onStarted before executing anything.
      await callbacks?.onStarted?.({ runId: 'eval-run-1', testCases });
      order.push('execute');
      const runDoc: any = { id: 'eval-run-1', status: 'completed', results: { 'tc-b1': { reportId: 'rep-1', status: 'completed', passFailStatus: 'passed' } } };
      return { runId: 'eval-run-1', run: runDoc, status: 'completed', testCases, logPath: '/tmp/x.log' };
    });
    await run(['-f', fileB, '-a', 'demo', '-n', 'shop', '--force', '--judge-model', 'demo-model']);
    const out = printed();
    expect(out).toMatch(/Warning: --force — adding the test cases of ".*b\.eval\.js" to benchmark "shop", which was created from "a\.eval\.js"/);
    expect(spinnerLines).toEqual([expect.stringMatching(/^Added 1 test case to "shop": b1$/)]);
    expect(api.patchBenchmarkMetadata).toHaveBeenCalledWith('bench-shop', { description: expect.stringMatching(/^CLI benchmark run from a\.eval\.js; .*b\.eval\.js added with --force$/) });
    expect(order).toEqual(['patch', 'execute']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(out).toMatch(/Passed: 1/);
  });
});
