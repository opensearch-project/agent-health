/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the import CLI command.
 */

jest.mock('chalk', () => ({
  default: {
    cyan: Object.assign((s: string) => s, { bold: (s: string) => s }),
    green: Object.assign((s: string) => s, { bold: (s: string) => s }),
    red: (s: string) => s,
    gray: (s: string) => s,
    bold: (s: string) => s,
  },
  cyan: Object.assign((s: string) => s, { bold: (s: string) => s }),
  green: Object.assign((s: string) => s, { bold: (s: string) => s }),
  red: (s: string) => s,
  gray: (s: string) => s,
  bold: (s: string) => s,
}));

jest.mock('ora', () => {
  return jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    text: '',
  }));
});

jest.mock('fs', () => ({
  writeFileSync: jest.fn(),
}));

jest.mock('@/cli/converters/index', () => ({
  convertAllFromLocal: jest.fn(),
  convertAllFromGitHub: jest.fn(),
}));

import { createImportCommand } from '@/cli/commands/import';
import { convertAllFromLocal, convertAllFromGitHub } from '@/cli/converters/index';
import { writeFileSync } from 'fs';

const mockConvertLocal = convertAllFromLocal as jest.MockedFunction<typeof convertAllFromLocal>;
const mockConvertGitHub = convertAllFromGitHub as jest.MockedFunction<typeof convertAllFromGitHub>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>;

describe('createImportCommand', () => {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  beforeEach(() => {
    jest.clearAllMocks();
    process.exit = jest.fn() as any;
    console.log = jest.fn();
    console.error = jest.fn();
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  });

  it('creates a command named "import"', () => {
    const cmd = createImportCommand();
    expect(cmd.name()).toBe('import');
  });

  it('has required --from option', () => {
    const cmd = createImportCommand();
    const fromOpt = cmd.options.find((o) => o.long === '--from');
    expect(fromOpt).toBeDefined();
    expect(fromOpt!.required).toBe(true);
  });

  it('has optional --source, --output, --dry-run options', () => {
    const cmd = createImportCommand();
    const optionNames = cmd.options.map((o) => o.long);
    expect(optionNames).toContain('--source');
    expect(optionNames).toContain('--output');
    expect(optionNames).toContain('--dry-run');
  });

  it('registers an optional [source] positional argument', () => {
    const cmd = createImportCommand();
    expect(cmd.registeredArguments).toHaveLength(1);
    expect(cmd.registeredArguments[0].name()).toBe('source');
    expect(cmd.registeredArguments[0].required).toBe(false);
  });

  it('rejects unsupported format', async () => {
    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'unknown']);
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unsupported format'));
  });

  it('uses local converter when --source is provided', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/some/path']);

    expect(mockConvertLocal).toHaveBeenCalledWith('/some/path');
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('uses GitHub converter when --source is omitted', async () => {
    mockConvertGitHub.mockResolvedValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt']);

    expect(mockConvertGitHub).toHaveBeenCalledWith('robusta-dev/holmesgpt', 'master', expect.any(Function));
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('does not write files in dry-run mode', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path', '--dry-run']);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('defaults output to holmesgpt-test-cases.json', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'test',
          description: 'Test',
          category: 'General',
          difficulty: 'Medium',
          initialPrompt: 'test',
          expectedOutcomes: ['result'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      'holmesgpt-test-cases.json',
      expect.any(String),
      'utf-8'
    );
  });

  it('derives the default output filename from --from when -o is omitted', async () => {
    mockConvertLocal.mockReturnValue({ testCases: [], skipped: [], errors: [] });

    const cmd = createImportCommand();
    // Case-normalized: --from HOLMESGPT should still default to the
    // lowercased 'holmesgpt-test-cases.json', not 'HOLMESGPT-test-cases.json'.
    await cmd.parseAsync(['node', 'test', '--from', 'HOLMESGPT', '--source', '/path']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      'holmesgpt-test-cases.json',
      expect.any(String),
      'utf-8'
    );
  });

  it('accepts a positional [source] argument as an alias for --source', async () => {
    mockConvertLocal.mockReturnValue({ testCases: [], skipped: [], errors: [] });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '/positional/path', '--from', 'holmesgpt']);

    expect(mockConvertLocal).toHaveBeenCalledWith('/positional/path');
    expect(mockConvertGitHub).not.toHaveBeenCalled();
  });

  it('prefers the positional [source] over --source when both are given', async () => {
    mockConvertLocal.mockReturnValue({ testCases: [], skipped: [], errors: [] });

    const cmd = createImportCommand();
    await cmd.parseAsync([
      'node',
      'test',
      '/positional/path',
      '--from',
      'holmesgpt',
      '--source',
      '/flag/path',
    ]);

    expect(mockConvertLocal).toHaveBeenCalledWith('/positional/path');
  });

  it('respects custom --output path', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'test',
          description: 'Test',
          category: 'General',
          difficulty: 'Medium',
          initialPrompt: 'test',
          expectedOutcomes: ['result'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path', '-o', 'custom.json']);

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      'custom.json',
      expect.any(String),
      'utf-8'
    );
  });

  it('is case-insensitive for --from and treats HOLMESGPT as supported', async () => {
    mockConvertLocal.mockReturnValue({ testCases: [], skipped: [], errors: [] });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'HOLMESGPT', '--source', '/path']);

    expect(process.exit).not.toHaveBeenCalled();
    expect(mockConvertLocal).toHaveBeenCalledWith('/path');
  });

  it('passes custom --repo and --branch through to the GitHub converter', async () => {
    mockConvertGitHub.mockResolvedValue({ testCases: [], skipped: [], errors: [] });

    const cmd = createImportCommand();
    await cmd.parseAsync([
      'node',
      'test',
      '--from',
      'holmesgpt',
      '--repo',
      'someone/fork',
      '--branch',
      'dev',
    ]);

    expect(mockConvertGitHub).toHaveBeenCalledWith('someone/fork', 'dev', expect.any(Function));
  });

  it('exits with an error when the local converter throws (malformed input / bad path)', async () => {
    mockConvertLocal.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/does-not-exist']);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ENOENT'));
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('exits with an error when the GitHub converter rejects (network failure)', async () => {
    mockConvertGitHub.mockRejectedValue(new Error('GitHub API error: 403 Forbidden'));

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt']);

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('GitHub API error'));
  });

  it('handles an empty result set (empty fixtures directory) without writing an empty summary crash', async () => {
    mockConvertLocal.mockReturnValue({ testCases: [], skipped: [], errors: [] });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/empty']);

    expect(mockWriteFileSync).toHaveBeenCalledWith('holmesgpt-test-cases.json', '[]\n', 'utf-8');
  });

  it('prints skipped and per-file error details in the summary, and exits non-zero on partial failure', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [],
      skipped: [{ path: '/path/skip/test_case.yaml', reason: 'Marked as skip' }],
      errors: [{ path: '/path/bad/test_case.yaml', error: 'Invalid YAML' }],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path']);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipped:'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Errors:'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('/path/bad/test_case.yaml: Invalid YAML'));
    // A partial import still writes the file (for inspection) but must not report success.
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('exits 0 (does not call process.exit) when there are no conversion errors', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'test',
          description: 'Test',
          category: 'General',
          difficulty: 'Medium',
          initialPrompt: 'test',
          expectedOutcomes: ['result'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path']);

    expect(process.exit).not.toHaveBeenCalled();
  });

  it('prints a sample test case in dry-run mode when results are present', async () => {
    mockConvertLocal.mockReturnValue({
      testCases: [
        {
          name: 'holmesgpt/test_ask_holmes/01_pods',
          description: 'Pods',
          category: 'Kubernetes',
          difficulty: 'Medium',
          initialPrompt: 'How many pods?',
          expectedOutcomes: ['3 pods'],
          context: [],
        },
      ],
      skipped: [],
      errors: [],
    });

    const cmd = createImportCommand();
    await cmd.parseAsync(['node', 'test', '--from', 'holmesgpt', '--source', '/path', '--dry-run']);

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sample test case'));
  });
});
