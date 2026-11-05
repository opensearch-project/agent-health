/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

const mockLoadConfig = jest.fn();
const mockEnsureServer = jest.fn();
const mockCreateServerCleanup = jest.fn();
const mockFindBenchmark = jest.fn();
const mockApiClient = jest.fn();
const mockWriteFileSync = jest.fn();

jest.mock('@/lib/config/index', () => ({
  loadConfig: (...args: any[]) => mockLoadConfig(...args),
  DEFAULT_SERVER_CONFIG: { port: 4001, reuseExistingServer: true, startTimeout: 30000 },
}));

jest.mock('@/cli/utils/serverLifecycle', () => ({
  ensureServer: (...args: any[]) => mockEnsureServer(...args),
  createServerCleanup: (...args: any[]) => mockCreateServerCleanup(...args),
}));

jest.mock('@/cli/utils/apiClient', () => ({
  ApiClient: jest.fn((...args: any[]) => mockApiClient(...args)),
}));

jest.mock('chalk', () => {
  const identity = (value: string) => value;
  const chalk = {
    cyan: identity,
    green: identity,
    red: identity,
    gray: identity,
    bold: identity,
  };
  return {
    __esModule: true,
    default: chalk,
    ...chalk,
  };
});

jest.mock('ora', () => ({
  __esModule: true,
  default: jest.fn((text?: string) => {
    const spinner = {
      text: text || '',
      start: jest.fn((nextText?: string) => {
        if (nextText) spinner.text = nextText;
        return spinner;
      }),
      succeed: jest.fn(() => spinner),
      fail: jest.fn(() => spinner),
      stop: jest.fn(() => spinner),
    };
    return spinner;
  }),
}));

jest.mock('fs', () => ({
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
}));

import { createReportCommand } from '@/cli/commands/report';

class ProcessExitError extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
  }
}

function makeResponse(options?: {
  ok?: boolean;
  status?: number;
  text?: string;
  json?: any;
  jsonReject?: boolean;
  arrayBuffer?: ArrayBuffer;
  headers?: Record<string, string>;
}) {
  const headers = Object.fromEntries(
    Object.entries(options?.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    ok: options?.ok ?? true,
    status: options?.status ?? 200,
    headers: {
      get: jest.fn((name: string) => headers[name.toLowerCase()] || null),
    },
    text: jest.fn().mockResolvedValue(options?.text ?? ''),
    json: options?.jsonReject
      ? jest.fn().mockRejectedValue(new Error('bad json'))
      : jest.fn().mockResolvedValue(options?.json ?? {}),
    arrayBuffer: jest.fn().mockResolvedValue(
      options?.arrayBuffer ?? Uint8Array.from([1, 2, 3]).buffer
    ),
  };
}

async function runReportCommand(args: string[]) {
  await createReportCommand().parseAsync(['node', 'report', ...args]);
}

describe('Report Command', () => {
  const originalFetch = global.fetch;
  let stdoutWriteSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let cleanupSpy: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    cleanupSpy = jest.fn();

    mockLoadConfig.mockResolvedValue({ server: { port: 4101 }, agents: [] });
    mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4101', wasStarted: false });
    mockCreateServerCleanup.mockReturnValue(cleanupSpy);
    mockFindBenchmark.mockResolvedValue({ id: 'bench-1', name: 'Benchmark One' });
    mockApiClient.mockImplementation(() => ({
      findBenchmark: mockFindBenchmark,
    }));

    global.fetch = jest.fn();
    stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true as any);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code ?? 0);
    }) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    stdoutWriteSpy.mockRestore();
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('command configuration', () => {
    it('should have name "report"', () => {
      const command = createReportCommand();
      expect(command.name()).toBe('report');
    });

    it('should have a description', () => {
      const command = createReportCommand();
      expect(command.description()).toContain('report');
    });

    it('should require --benchmark option', () => {
      const command = createReportCommand();
      const benchmarkOption = command.options.find((o) => o.long === '--benchmark');
      expect(benchmarkOption).toBeDefined();
      expect(benchmarkOption!.mandatory).toBe(true);
    });

    it('should have --format option with default "html"', () => {
      const command = createReportCommand();
      const formatOption = command.options.find((o) => o.long === '--format');
      expect(formatOption).toBeDefined();
      expect(formatOption!.defaultValue).toBe('html');
    });

    it('should have optional --runs option', () => {
      const command = createReportCommand();
      const runsOption = command.options.find((o) => o.long === '--runs');
      expect(runsOption).toBeDefined();
      expect(runsOption!.mandatory).toBeFalsy();
    });

    it('should have optional --output option', () => {
      const command = createReportCommand();
      const outputOption = command.options.find((o) => o.long === '--output');
      expect(outputOption).toBeDefined();
    });

    it('should have --stdout flag', () => {
      const command = createReportCommand();
      const stdoutOption = command.options.find((o) => o.long === '--stdout');
      expect(stdoutOption).toBeDefined();
    });
  });

  describe('action', () => {
    it('writes a text report to the default filename from the response header', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        makeResponse({
          text: '<html>report</html>',
          headers: {
            'content-disposition': 'attachment; filename="custom-report.html"',
            'content-type': 'text/html',
          },
        })
      );

      await runReportCommand([
        '--benchmark',
        'bench-1',
        '--format',
        'html',
        '--runs',
        'run-1,run-2',
      ]);

      expect(mockEnsureServer).toHaveBeenCalledWith(
        expect.objectContaining({ port: 4101 })
      );
      expect(mockFindBenchmark).toHaveBeenCalledWith('bench-1');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:4101/api/storage/benchmarks/bench-1/report?format=html&runIds=run-1%2Crun-2'
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith('custom-report.html', '<html>report</html>');
      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('writes JSON to stdout when --stdout is used', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        makeResponse({
          text: '{"ok":true}',
          headers: { 'content-type': 'application/json' },
        })
      );

      await runReportCommand([
        '--benchmark',
        'bench-1',
        '--format',
        'json',
        '--stdout',
      ]);

      expect(stdoutWriteSpy).toHaveBeenCalledWith('{"ok":true}');
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('--stdout: the report body is the ONLY thing written to stdout (machine-readable contract)', async () => {
      // `report -f json --stdout | jq` must parse. Spinners (ora → stderr) and
      // lifecycle/config diagnostics must never share stdout with the body.
      mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4101', wasStarted: true });
      (global.fetch as jest.Mock).mockResolvedValue(
        makeResponse({
          text: '{"benchmark":{"id":"bench-1"},"runs":[]}',
          headers: { 'content-type': 'application/json' },
        })
      );

      await runReportCommand(['--benchmark', 'bench-1', '--format', 'json', '--stdout']);

      const stdoutText = stdoutWriteSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(JSON.parse(stdoutText)).toEqual({ benchmark: { id: 'bench-1' }, runs: [] });
      // console.log is stdout: nothing in the command may use it on this path.
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('writes PDF reports as buffers and respects --output', async () => {
      mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4101', wasStarted: true });
      const pdfBuffer = Uint8Array.from([80, 68, 70]).buffer;
      (global.fetch as jest.Mock).mockResolvedValue(
        makeResponse({
          arrayBuffer: pdfBuffer,
          headers: { 'content-type': 'application/pdf' },
        })
      );

      await runReportCommand([
        '--benchmark',
        'bench-1',
        '--format',
        'pdf',
        '--output',
        'report.pdf',
      ]);

      expect(mockWriteFileSync).toHaveBeenCalledWith('report.pdf', Buffer.from(pdfBuffer));
      expect(cleanupSpy).toHaveBeenCalled();
    });

    it('exits when the benchmark cannot be found and still cleans up the server handle', async () => {
      mockFindBenchmark.mockResolvedValue(null);

      await expect(
        runReportCommand(['--benchmark', 'missing-benchmark'])
      ).rejects.toMatchObject({ code: 1 });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(cleanupSpy).toHaveBeenCalled();
      // Failure hints are diagnostics → stderr, never stdout (which may be piped to jq).
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Available benchmarks'));
      expect(logSpy).not.toHaveBeenCalled();
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('exits when the server cannot be reached before the API client is used', async () => {
      mockEnsureServer.mockRejectedValue(new Error('connection refused'));

      await expect(
        runReportCommand(['--benchmark', 'bench-1'])
      ).rejects.toMatchObject({ code: 1 });

      expect(mockCreateServerCleanup).not.toHaveBeenCalled();
      expect(mockApiClient).not.toHaveBeenCalled();
    });

    it('exits when report generation fails and falls back to an unknown error body', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        makeResponse({
          ok: false,
          status: 500,
          jsonReject: true,
        })
      );

      await expect(
        runReportCommand(['--benchmark', 'bench-1'])
      ).rejects.toMatchObject({ code: 1 });

      expect(cleanupSpy).toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('action — fall-through after process.exit(1) (regression)', () => {
    // In all three cases below, process.exit is stubbed so it does NOT
    // actually terminate the process (as it wouldn't in a caller that
    // swallows it, or under some future test harness). Before the fix, the
    // code fell through past `process.exit(1)` into logic that either
    // dereferenced an undefined value or treated an error response body as
    // a valid report. The fix adds an explicit `return` after each
    // `process.exit(1)` so no further work happens on that path.
    let exitSpy: jest.SpyInstance;
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
      jest.clearAllMocks();
      mockEnsureServer.mockResolvedValue({ baseUrl: 'http://localhost:4001', wasStarted: false });
      mockCreateServerCleanup.mockReturnValue(jest.fn());
      mockFindBenchmark.mockReset();
      mockWriteFileSync.mockReset();
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(((): never => undefined as never) as any);
      jest.spyOn(console, 'log').mockImplementation();
      jest.spyOn(console, 'error').mockImplementation();
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('stops after benchmark-not-found instead of dereferencing undefined benchmark', async () => {
      mockFindBenchmark.mockResolvedValue(undefined);

      const command = createReportCommand();

      await expect(
        command.parseAsync(['-b', 'does-not-exist'], { from: 'user' })
      ).resolves.not.toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);
      // Must not have proceeded to fetch/write a report for a benchmark that
      // doesn't exist.
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('stops after a failed report fetch instead of writing the error body as the report', async () => {
      mockFindBenchmark.mockResolvedValue({ id: 'bm-1', name: 'My Benchmark' });
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        json: async () => ({ error: 'boom' }),
        headers: new Map(),
        text: async () => 'error body',
      } as any);

      const command = createReportCommand();

      await expect(
        command.parseAsync(['-b', 'bm-1', '-o', 'out.html'], { from: 'user' })
      ).resolves.not.toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);
      // Regression: before the fix, execution fell through past the
      // !response.ok branch and wrote the error response body to disk as if
      // it were a valid report.
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('stops after a server-connection failure instead of using an unassigned serverResult', async () => {
      mockEnsureServer.mockRejectedValue(new Error('connection refused'));

      const command = createReportCommand();

      await expect(
        command.parseAsync(['-b', 'bm-1'], { from: 'user' })
      ).resolves.not.toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockFindBenchmark).not.toHaveBeenCalled();
    });
  });
});
