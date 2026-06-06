/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, describe as ahDescribe, getRegisteredTests, clearRegistry, setActiveFile, _resetExperimentalWarning } from '@/lib/testCases/define';

describe('test() API', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('registers a test case with name + options + body', () => {
    test('My Test', {
      prompt: 'Analyze the issue',
      labels: ['category:RCA', 'difficulty:Medium'],
    }, async () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe('My Test');
    expect(tests[0].options.prompt).toBe('Analyze the issue');
    expect(tests[0].options.labels).toEqual(['category:RCA', 'difficulty:Medium']);
  });

  it('registers a test case with name + body only (no options)', () => {
    test('No options test', () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].name).toBe('No options test');
    expect(tests[0].options).toEqual({});
  });

  it('registers a test case without a prompt (deterministic test)', () => {
    test('Deterministic only', { labels: ['kind:smoke'] }, () => {});

    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].options.prompt).toBeUndefined();
    expect(tests[0].options.labels).toEqual(['kind:smoke']);
  });

  it('throws when name is empty', () => {
    expect(() => test('', { prompt: 'p' }, () => {}))
      .toThrow('test() requires a name');
  });

  it('throws when body is not a function (3-arg form)', () => {
    expect(() => test('T', { prompt: 'p' }, null as any))
      .toThrow('requires a body function');
  });

  it('throws when body is not a function (2-arg form)', () => {
    expect(() => (test as any)('T', null))
      .toThrow('requires a body function');
  });

  it('accepts every optional field', () => {
    test('Full Test', {
      prompt: 'Investigate',
      description: 'A full test',
      context: [{ description: 'env', value: 'prod' }],
      labels: ['category:Security', 'difficulty:Hard'],
      timeout: 60000,
    }, () => {});

    const tests = getRegisteredTests();
    expect(tests[0].options.description).toBe('A full test');
    expect(tests[0].options.context).toHaveLength(1);
    expect(tests[0].options.labels).toEqual(['category:Security', 'difficulty:Hard']);
    expect(tests[0].options.timeout).toBe(60000);
  });

  it('registers multiple test cases with distinct names', () => {
    test('Test 1', { prompt: 'p1' }, () => {});
    test('Test 2', { prompt: 'p2' }, () => {});
    test('Test 3', { prompt: 'p3' }, () => {});

    expect(getRegisteredTests()).toHaveLength(3);
  });
});

describe('duplicate detection', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('throws when the same name is registered twice in the same file', () => {
    setActiveFile('/path/dup.eval.js');
    test('login works', { prompt: 'p' }, () => {});
    expect(() => test('login works', { prompt: 'p2' }, () => {}))
      .toThrow(/Duplicate test name "login works"/);
  });

  it('throws even when one form has options and the other does not', () => {
    setActiveFile('/path/dup.eval.js');
    test('foo', () => {});
    expect(() => test('foo', { prompt: 'p' }, () => {}))
      .toThrow(/Duplicate test name "foo"/);
  });

  it('allows the same name in different files (cross-file is fine)', () => {
    setActiveFile('/path/file-a.eval.js');
    test('login', { prompt: 'p' }, () => {});

    setActiveFile('/path/file-b.eval.js');
    expect(() => test('login', { prompt: 'p' }, () => {})).not.toThrow();

    expect(getRegisteredTests('/path/file-a.eval.js')).toHaveLength(1);
    expect(getRegisteredTests('/path/file-b.eval.js')).toHaveLength(1);
  });

  it('mentions the active file in the error message when set', () => {
    setActiveFile('/path/specific.eval.js');
    test('foo', () => {});
    expect(() => test('foo', () => {}))
      .toThrow(/in \/path\/specific\.eval\.js/);
  });
});

describe('file-scoped registries', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('isolates tests by file path', () => {
    setActiveFile('/path/file1.eval.ts');
    test('File1 Test', { prompt: 'p' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('File2 Test', { prompt: 'p' }, () => {});

    expect(getRegisteredTests('/path/file1.eval.ts')).toHaveLength(1);
    expect(getRegisteredTests('/path/file2.eval.ts')).toHaveLength(1);
    expect(getRegisteredTests()).toHaveLength(2);
  });

  it('records sourceFile on each registered test case', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p' }, () => {});

    const tests = getRegisteredTests('/path/file1.eval.ts');
    expect(tests[0].sourceFile).toBe('/path/file1.eval.ts');
  });

  it('clearRegistry with filePath only clears that file', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('T2', { prompt: 'p' }, () => {});

    clearRegistry('/path/file1.eval.ts');
    expect(getRegisteredTests('/path/file1.eval.ts')).toHaveLength(0);
    expect(getRegisteredTests('/path/file2.eval.ts')).toHaveLength(1);
  });

  it('clearRegistry without args clears everything', () => {
    setActiveFile('/path/file1.eval.ts');
    test('T1', { prompt: 'p' }, () => {});

    setActiveFile('/path/file2.eval.ts');
    test('T2', { prompt: 'p' }, () => {});

    clearRegistry();
    expect(getRegisteredTests()).toHaveLength(0);
  });
});

describe('describe() API', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('attaches benchmarkPath = describe name to nested test() calls', () => {
    ahDescribe('RCA Suite', () => {
      test('finds root cause', { prompt: 'p' }, () => {});
    });
    const tests = getRegisteredTests();
    expect(tests).toHaveLength(1);
    expect(tests[0].benchmarkPath).toBe('RCA Suite');
  });

  it('flattens nested describes with " > "', () => {
    ahDescribe('A', () => {
      ahDescribe('B', () => {
        test('t', { prompt: 'p' }, () => {});
      });
    });
    expect(getRegisteredTests()[0].benchmarkPath).toBe('A > B');
  });

  it('tests outside any describe have undefined benchmarkPath', () => {
    test('orphan', () => {});
    expect(getRegisteredTests()[0].benchmarkPath).toBeUndefined();
  });

  it('mixes describe-grouped and orphan tests in the same file', () => {
    ahDescribe('Group', () => {
      test('grouped', () => {});
    });
    test('orphan', () => {});
    const tests = getRegisteredTests();
    expect(tests.find(t => t.name === 'grouped')!.benchmarkPath).toBe('Group');
    expect(tests.find(t => t.name === 'orphan')!.benchmarkPath).toBeUndefined();
  });

  it('allows the same test name in different describes', () => {
    ahDescribe('A', () => {
      test('shared', () => {});
    });
    ahDescribe('B', () => {
      test('shared', () => {});
    });
    const tests = getRegisteredTests();
    expect(tests).toHaveLength(2);
    expect(tests.map(t => t.benchmarkPath)).toEqual(['A', 'B']);
  });

  it('throws on duplicate test name within the same describe', () => {
    expect(() => {
      ahDescribe('A', () => {
        test('dup', () => {});
        test('dup', () => {});
      });
    }).toThrow(/Duplicate test name "dup".*in describe "A"/);
  });

  it('throws if describe body returns a Promise', () => {
    expect(() => ahDescribe('A', (async () => {}) as any))
      .toThrow(/describe.*body returned a Promise/);
  });

  it('requires a name', () => {
    expect(() => ahDescribe('', () => {})).toThrow(/requires a name/);
  });

  it('requires a body function', () => {
    expect(() => ahDescribe('A', undefined as any)).toThrow(/requires a body function/);
  });
});

describe('experimental warning', () => {
  let warnSpy: jest.SpyInstance;
  let originalNew: string | undefined;
  let originalLegacy: string | undefined;
  let originalQuietDeprecations: string | undefined;

  beforeEach(() => {
    clearRegistry();
    _resetExperimentalWarning();
    originalNew = process.env.AH_SUPPRESS_EXPERIMENTAL;
    originalLegacy = process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    originalQuietDeprecations = process.env.AH_QUIET_DEPRECATIONS;
    delete process.env.AH_SUPPRESS_EXPERIMENTAL;
    delete process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    process.env.AH_QUIET_DEPRECATIONS = '1';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalNew === undefined) delete process.env.AH_SUPPRESS_EXPERIMENTAL;
    else process.env.AH_SUPPRESS_EXPERIMENTAL = originalNew;
    if (originalLegacy === undefined) delete process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    else process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL = originalLegacy;
    if (originalQuietDeprecations === undefined) delete process.env.AH_QUIET_DEPRECATIONS;
    else process.env.AH_QUIET_DEPRECATIONS = originalQuietDeprecations;
  });

  it('emits the experimental warning the first time test() is called', () => {
    test('First', { prompt: 'p' }, async () => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/experimental/i);
  });

  it('does not emit again on subsequent test() calls', () => {
    test('First', { prompt: 'p' }, async () => {});
    test('Second', { prompt: 'p' }, async () => {});
    test('Third', { prompt: 'p' }, async () => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('is suppressed when AH_SUPPRESS_EXPERIMENTAL=1 is set', () => {
    process.env.AH_SUPPRESS_EXPERIMENTAL = '1';
    test('First', { prompt: 'p' }, async () => {});
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is also suppressed when legacy AGENT_HEALTH_SUPPRESS_EXPERIMENTAL=1 is set', () => {
    process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL = '1';
    test('First', { prompt: 'p' }, async () => {});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
