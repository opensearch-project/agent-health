/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  test,
  describe as ahDescribe,
  beforeAll as ahBeforeAll,
  afterAll as ahAfterAll,
  beforeEach as ahBeforeEach,
  afterEach as ahAfterEach,
  getRegisteredTests,
  getRegisteredHooks,
  clearRegistry,
  setActiveFile,
  _resetExperimentalWarning,
} from '@/lib/testCases/define';

describe('hook registration — standalone form', () => {
  beforeEach(() => clearRegistry());

  it('registers each of the four hook kinds with kind preserved', () => {
    setActiveFile('/path/hooks.eval.js');
    ahBeforeAll(() => {});
    ahAfterAll(() => {});
    ahBeforeEach(() => {});
    ahAfterEach(() => {});

    const hooks = getRegisteredHooks('/path/hooks.eval.js');
    expect(hooks.map(h => h.kind)).toEqual(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
  });

  it('records sourceFile and undefined describePath at file top level', () => {
    setActiveFile('/path/file.eval.js');
    ahBeforeEach(() => {});
    const [hook] = getRegisteredHooks('/path/file.eval.js');
    expect(hook.sourceFile).toBe('/path/file.eval.js');
    expect(hook.describePath).toBeUndefined();
  });

  it('captures the live describe path at registration time', () => {
    setActiveFile('/path/file.eval.js');
    ahDescribe('A', () => {
      ahDescribe('B', () => {
        ahBeforeEach(() => {});
      });
      ahAfterEach(() => {});
    });
    const hooks = getRegisteredHooks('/path/file.eval.js');
    const innerBeforeEach = hooks.find(h => h.kind === 'beforeEach');
    const outerAfterEach = hooks.find(h => h.kind === 'afterEach');
    expect(innerBeforeEach?.describePath).toBe('A > B');
    expect(outerAfterEach?.describePath).toBe('A');
  });

  it('allows multiple hooks of the same kind in the same scope', () => {
    setActiveFile('/path/multi.eval.js');
    ahBeforeEach(() => {});
    ahBeforeEach(() => {});
    ahBeforeEach(() => {});
    expect(getRegisteredHooks('/path/multi.eval.js')).toHaveLength(3);
  });

  it('throws when the argument is not a function', () => {
    expect(() => (ahBeforeEach as any)(null)).toThrow(/requires a function/);
    expect(() => (ahAfterAll as any)(undefined)).toThrow(/requires a function/);
  });

  it('isolates hooks by file', () => {
    setActiveFile('/a.eval.js'); ahBeforeEach(() => {});
    setActiveFile('/b.eval.js'); ahAfterEach(() => {});
    expect(getRegisteredHooks('/a.eval.js')).toHaveLength(1);
    expect(getRegisteredHooks('/b.eval.js')).toHaveLength(1);
    expect(getRegisteredHooks()).toHaveLength(2);
  });

  it('clears hooks alongside tests', () => {
    setActiveFile('/x.eval.js');
    test('t', () => {});
    ahBeforeEach(() => {});
    clearRegistry('/x.eval.js');
    expect(getRegisteredTests('/x.eval.js')).toHaveLength(0);
    expect(getRegisteredHooks('/x.eval.js')).toHaveLength(0);
  });
});

describe('hook registration — test.X static form', () => {
  beforeEach(() => clearRegistry());

  it('exposes test.beforeAll/afterAll/beforeEach/afterEach', () => {
    setActiveFile('/path/static.eval.js');
    test.beforeAll(() => {});
    test.afterAll(() => {});
    test.beforeEach(() => {});
    test.afterEach(() => {});
    const kinds = getRegisteredHooks('/path/static.eval.js').map(h => h.kind);
    expect(kinds).toEqual(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
  });

  it('test.X and standalone forms route to the same registry', () => {
    setActiveFile('/path/equal.eval.js');
    ahBeforeEach(() => {});
    test.beforeEach(() => {});
    expect(getRegisteredHooks('/path/equal.eval.js')).toHaveLength(2);
  });
});

describe('hook + test interaction', () => {
  beforeEach(() => clearRegistry());

  it('does not affect existing test() registration', () => {
    setActiveFile('/path/mix.eval.js');
    ahBeforeEach(() => {});
    test('t', () => {});
    ahAfterEach(() => {});
    expect(getRegisteredTests('/path/mix.eval.js')).toHaveLength(1);
    expect(getRegisteredHooks('/path/mix.eval.js')).toHaveLength(2);
  });

  it('hooks inside describe attach to the describe scope', () => {
    setActiveFile('/path/nested.eval.js');
    ahDescribe('S', () => {
      ahBeforeEach(() => {});
      test('t', () => {});
    });
    const hooks = getRegisteredHooks('/path/nested.eval.js');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].describePath).toBe('S');
    expect(getRegisteredTests('/path/nested.eval.js')[0].benchmarkPath).toBe('S');
  });
});

describe('experimental warning still emits for hooks', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    clearRegistry();
    _resetExperimentalWarning();
    delete process.env.AGENT_HEALTH_SUPPRESS_EXPERIMENTAL;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  it('emits exactly once when only hooks are used (no test() calls)', () => {
    ahBeforeEach(() => {});
    ahAfterEach(() => {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
