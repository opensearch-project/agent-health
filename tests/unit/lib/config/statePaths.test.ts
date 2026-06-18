/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for config-v2 state-path + mode resolution (#271).
 * fs and os are mocked so nothing touches disk.
 */

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));
jest.mock('os', () => ({ homedir: jest.fn(() => '/home/tester') }));

import * as fs from 'fs';
import {
  STATE_DIRNAME,
  STATE_FILENAME,
  DATA_DIRNAME,
  projectStatePath,
  userStatePath,
  projectDataDir,
  isCodeFirstMode,
  hasAuthoredConfig,
  readLayeredState,
  writeStateScope,
} from '@/lib/config/statePaths';

const mockedFs = fs as jest.Mocked<typeof fs>;
const CWD = process.cwd();

beforeEach(() => {
  jest.clearAllMocks();
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.readFileSync.mockReturnValue('{}');
  mockedFs.writeFileSync.mockImplementation(() => {});
  mockedFs.mkdirSync.mockImplementation(() => undefined as any);
});

describe('path helpers', () => {
  it('project + user state paths use .agent-health/state.json', () => {
    expect(projectStatePath(CWD)).toBe(`${CWD}/${STATE_DIRNAME}/${STATE_FILENAME}`);
    expect(userStatePath()).toBe(`/home/tester/${STATE_DIRNAME}/${STATE_FILENAME}`);
  });
});

describe('mode detection', () => {
  it('isCodeFirstMode true when a project agent-health.config.ts exists', () => {
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('agent-health.config.ts'));
    expect(hasAuthoredConfig(CWD)).toBe(true);
    expect(isCodeFirstMode(CWD)).toBe(true);
  });

  it('isCodeFirstMode true when a user ~/.agent-health/agent-health.config.ts exists', () => {
    mockedFs.existsSync.mockImplementation((p: any) =>
      String(p) === `/home/tester/${STATE_DIRNAME}/agent-health.config.ts`);
    expect(isCodeFirstMode(CWD)).toBe(true);
  });

  it('isCodeFirstMode false when no authored config anywhere', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(isCodeFirstMode(CWD)).toBe(false);
  });
});

describe('readLayeredState', () => {
  it('returns {} in code-first mode (state ignored)', () => {
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('agent-health.config.ts'));
    expect(readLayeredState(CWD)).toEqual({});
  });

  it('merges project over user, per top-level key', () => {
    // No authored config -> ui-first.
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('state.json'));
    mockedFs.readFileSync.mockImplementation((p: any) => {
      if (String(p) === userStatePath()) {
        return JSON.stringify({ storage: { endpoint: 'user' }, debug: true });
      }
      if (String(p) === projectStatePath(CWD)) {
        return JSON.stringify({ storage: { endpoint: 'project' } });
      }
      return '{}';
    });
    const merged = readLayeredState(CWD);
    expect((merged.storage as any).endpoint).toBe('project'); // project wins
    expect(merged.debug).toBe(true);                          // user-only key preserved
  });
});

describe('writeStateScope', () => {
  it('throws in code-first mode', () => {
    mockedFs.existsSync.mockImplementation((p: any) => String(p).endsWith('agent-health.config.ts'));
    expect(() => writeStateScope({ debug: true }, 'project', CWD)).toThrow(/code-first/);
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('merges patch into the project file, preserving siblings', () => {
    mockedFs.existsSync.mockImplementation((p: any) => String(p) === projectStatePath(CWD));
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ debug: true, storage: { endpoint: 'x' } }));
    let written = '';
    mockedFs.writeFileSync.mockImplementation((_p: any, data: any) => { written = data as string; });

    writeStateScope({ storage: { endpoint: 'y' } }, 'project', CWD);

    const out = JSON.parse(written);
    expect(out.storage.endpoint).toBe('y'); // replaced
    expect(out.debug).toBe(true);           // sibling preserved
    expect(mockedFs.mkdirSync).toHaveBeenCalled();
  });

  it('deletes a key when its patch value is undefined', () => {
    mockedFs.existsSync.mockImplementation((p: any) => String(p) === projectStatePath(CWD));
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ debug: true, storage: { endpoint: 'x' } }));
    let written = '';
    mockedFs.writeFileSync.mockImplementation((_p: any, data: any) => { written = data as string; });

    writeStateScope({ storage: undefined }, 'project', CWD);

    const out = JSON.parse(written);
    expect(out).not.toHaveProperty('storage');
    expect(out.debug).toBe(true);
  });

  it('refuses to clobber a corrupt existing file', () => {
    mockedFs.existsSync.mockImplementation((p: any) => String(p) === projectStatePath(CWD));
    mockedFs.readFileSync.mockReturnValue('NOT JSON {{{');
    expect(() => writeStateScope({ debug: true }, 'project', CWD)).toThrow(/unreadable or corrupt/);
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe('combined data dir (.agent-health/data)', () => {
  it('projectDataDir nests generated data under the app-managed state dir', () => {
    expect(projectDataDir('/proj')).toBe(`/proj/${STATE_DIRNAME}/${DATA_DIRNAME}`);
  });
});
