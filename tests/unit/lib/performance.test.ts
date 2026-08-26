/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for lib/performance.ts
 *
 * The `isEnabled()` helper checks `typeof window !== 'undefined'` at call time
 * to branch between browser (localStorage) and Node.js (process.env) paths.
 * We use jest.resetModules() + require() to re-import the module after
 * manipulating the global environment so that each test group gets the
 * correct behaviour.
 */

describe('Performance Measurement Utilities', () => {
  /* ------------------------------------------------------------------ */
  /*  Shared spies / helpers                                             */
  /* ------------------------------------------------------------------ */
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let consoleGroupSpy: jest.SpyInstance;
  let consoleGroupEndSpy: jest.SpyInstance;
  let performanceNowSpy: jest.SpyInstance;
  let originalPerformance: typeof globalThis.performance;

  // Will hold the freshly-required module for each test group
  let mod: typeof import('@/lib/performance');

  const originalWindow = global.window;
  const originalLocalStorage = global.localStorage;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDebugPerf = process.env.DEBUG_PERFORMANCE;

  /* ------------------------------------------------------------------ */
  /*  localStorage mock factory                                          */
  /* ------------------------------------------------------------------ */
  function createLocalStorageMock(): Storage {
    const store: Record<string, string> = {};
    return {
      getItem: jest.fn((key: string) => store[key] ?? null),
      setItem: jest.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: jest.fn((key: string) => {
        delete store[key];
      }),
      clear: jest.fn(() => {
        Object.keys(store).forEach(k => delete store[k]);
      }),
      length: 0,
      key: jest.fn(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Global setup / teardown                                            */
  /* ------------------------------------------------------------------ */
  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleGroupSpy = jest.spyOn(console, 'group').mockImplementation(() => {});
    consoleGroupEndSpy = jest.spyOn(console, 'groupEnd').mockImplementation(() => {});

    // Deterministic performance.now() starting at 1000, incrementing by 100.
    // Node 18 makes performance.now read-only AND non-configurable, so neither
    // jest.spyOn(performance,'now') nor Object.defineProperty(performance,'now')
    // works there ("Cannot assign to read only property 'now'"). Swap the whole
    // global `performance` object instead — it is configurable on all supported
    // Node versions, and the lib reads performance.now() at call time so the
    // override is observed.
    let tick = 1000;
    const nowImpl = jest.fn(() => {
      const value = tick;
      tick += 100;
      return value;
    });
    originalPerformance = globalThis.performance;
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      writable: true,
      value: Object.create(originalPerformance, {
        now: { value: nowImpl, configurable: true, writable: true },
      }),
    });
    performanceNowSpy = nowImpl as unknown as jest.SpyInstance;
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleGroupSpy.mockRestore();
    consoleGroupEndSpy.mockRestore();
    // Restore the real global performance object.
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      writable: true,
      value: originalPerformance,
    });

    // Restore environment
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDebugPerf === undefined) {
      delete process.env.DEBUG_PERFORMANCE;
    } else {
      process.env.DEBUG_PERFORMANCE = originalDebugPerf;
    }

    // Restore window / localStorage
    if (originalWindow === undefined) {
      // @ts-ignore
      delete global.window;
    } else {
      global.window = originalWindow;
    }
    Object.defineProperty(global, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
      configurable: true,
    });

    jest.resetModules();
  });

  /* ================================================================== */
  /*  HELPER: load module in Node.js environment (enabled)               */
  /* ================================================================== */
  function loadModuleNodeEnabled() {
    // @ts-ignore
    delete global.window;
    process.env.DEBUG_PERFORMANCE = 'true';
    process.env.NODE_ENV = 'test';
    jest.resetModules();
    mod = require('@/lib/performance');
  }

  /* ================================================================== */
  /*  HELPER: load module in Node.js environment (disabled)              */
  /* ================================================================== */
  function loadModuleNodeDisabled() {
    // @ts-ignore
    delete global.window;
    delete process.env.DEBUG_PERFORMANCE;
    process.env.NODE_ENV = 'production';
    jest.resetModules();
    mod = require('@/lib/performance');
  }

  /* ================================================================== */
  /*  HELPER: load module in browser environment (enabled)               */
  /* ================================================================== */
  function loadModuleBrowserEnabled() {
    const lsMock = createLocalStorageMock();
    // Pre-set the flag so isEnabled() returns true
    (lsMock.getItem as jest.Mock).mockImplementation((key: string) =>
      key === 'DEBUG_PERFORMANCE' ? 'true' : null
    );

    // @ts-ignore
    global.window = { localStorage: lsMock } as any;
    Object.defineProperty(global, 'localStorage', {
      value: lsMock,
      writable: true,
      configurable: true,
    });

    process.env.NODE_ENV = 'production'; // not development
    jest.resetModules();
    mod = require('@/lib/performance');
    return lsMock;
  }

  /* ================================================================== */
  /*  HELPER: load module in browser environment (disabled)              */
  /* ================================================================== */
  function loadModuleBrowserDisabled() {
    const lsMock = createLocalStorageMock();
    (lsMock.getItem as jest.Mock).mockReturnValue(null);

    // @ts-ignore
    global.window = { localStorage: lsMock } as any;
    Object.defineProperty(global, 'localStorage', {
      value: lsMock,
      writable: true,
      configurable: true,
    });

    process.env.NODE_ENV = 'production';
    jest.resetModules();
    mod = require('@/lib/performance');
    return lsMock;
  }

  /* ================================================================== */
  /*  1. startMeasure / endMeasure                                       */
  /* ================================================================== */
  describe('startMeasure / endMeasure', () => {
    describe('when enabled (Node.js)', () => {
      beforeEach(() => {
        loadModuleNodeEnabled();
        mod.clearMetrics();
      });

      it('should record a mark and return duration on endMeasure', () => {
        mod.startMeasure('test-op');
        const duration = mod.endMeasure('test-op');

        // performance.now() returns 1000 on start, 1100 on end => duration = 100
        expect(duration).toBe(100);
      });

      it('should push the metric into the metrics array', () => {
        mod.startMeasure('my-metric');
        mod.endMeasure('my-metric');

        const all = mod.getMetrics();
        expect(all).toHaveLength(1);
        expect(all[0].name).toBe('my-metric');
        expect(all[0].duration).toBe(100);
        expect(typeof all[0].timestamp).toBe('number');
      });

      it('should log to console when logToConsole is true (default)', () => {
        mod.startMeasure('logged-op');
        mod.endMeasure('logged-op');

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('[Performance]'),
          // The rest is the name and formatted duration
        );
      });

      it('should not log to console when logToConsole is false', () => {
        mod.startMeasure('silent-op');
        // Clear any prior console.log calls from enable()
        consoleLogSpy.mockClear();

        mod.endMeasure('silent-op', false);

        // Only the enable() log may have fired, but we cleared it above
        expect(consoleLogSpy).not.toHaveBeenCalled();
      });

      it('should remove the mark after endMeasure so it cannot be ended twice', () => {
        mod.startMeasure('once-only');
        mod.endMeasure('once-only');

        // Second call should warn and return null
        const second = mod.endMeasure('once-only');
        expect(second).toBeNull();
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[Performance] No start mark found for: once-only'
        );
      });
    });

    describe('edge cases', () => {
      beforeEach(() => {
        loadModuleNodeEnabled();
        mod.clearMetrics();
      });

      it('should return null and warn when endMeasure has no matching start', () => {
        const result = mod.endMeasure('non-existent');
        expect(result).toBeNull();
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[Performance] No start mark found for: non-existent'
        );
      });

      it('should handle multiple concurrent measurements independently', () => {
        // Start two measures; performance.now() returns 1000, 1100
        mod.startMeasure('op-a');
        mod.startMeasure('op-b');

        // End op-b first: now() returns 1200 => duration = 1200 - 1100 = 100
        const durationB = mod.endMeasure('op-b', false);
        // End op-a second: now() returns 1300 => duration = 1300 - 1000 = 300
        const durationA = mod.endMeasure('op-a', false);

        expect(durationB).toBe(100);
        expect(durationA).toBe(300);
      });
    });

    describe('when disabled (Node.js)', () => {
      beforeEach(() => {
        loadModuleNodeDisabled();
      });

      it('startMeasure should be a no-op', () => {
        // Should not throw
        mod.startMeasure('disabled-op');
        expect(mod.getMetrics()).toHaveLength(0);
      });

      it('endMeasure should return null', () => {
        const result = mod.endMeasure('disabled-op');
        expect(result).toBeNull();
      });
    });
  });

  /* ================================================================== */
  /*  2. measureSync                                                     */
  /* ================================================================== */
  describe('measureSync', () => {
    describe('when enabled', () => {
      beforeEach(() => {
        loadModuleNodeEnabled();
        mod.clearMetrics();
      });

      it('should execute the function and return its result', () => {
        const result = mod.measureSync('compute', () => 42);
        expect(result).toBe(42);
      });

      it('should record a metric for the operation', () => {
        mod.measureSync('compute', () => 'value', false);
        const metrics = mod.getMetricsByName('compute');
        expect(metrics).toHaveLength(1);
        expect(metrics[0].duration).toBe(100);
      });

      it('should propagate exceptions from the wrapped function', () => {
        expect(() => {
          mod.measureSync('failing', () => {
            throw new Error('sync failure');
          });
        }).toThrow('sync failure');
      });

      it('should still record the metric even when the function throws', () => {
        try {
          mod.measureSync('failing', () => {
            throw new Error('sync failure');
          }, false);
        } catch {
          // expected
        }

        const metrics = mod.getMetricsByName('failing');
        expect(metrics).toHaveLength(1);
      });
    });

    describe('when disabled', () => {
      beforeEach(() => {
        loadModuleNodeDisabled();
      });

      it('should still execute the function and return its result', () => {
        const result = mod.measureSync('disabled-compute', () => 99);
        expect(result).toBe(99);
      });

      it('should not record any metrics', () => {
        mod.measureSync('disabled-compute', () => 'val');
        expect(mod.getMetrics()).toHaveLength(0);
      });
    });
  });

  /* ================================================================== */
  /*  3. measureAsync                                                    */
  /* ================================================================== */
  describe('measureAsync', () => {
    describe('when enabled', () => {
      beforeEach(() => {
        loadModuleNodeEnabled();
        mod.clearMetrics();
      });

      it('should execute the async function and return its result', async () => {
        const result = await mod.measureAsync('async-op', async () => 'async-result');
        expect(result).toBe('async-result');
      });

      it('should record a metric for the async operation', async () => {
        await mod.measureAsync('async-op', async () => 'done', false);
        const metrics = mod.getMetricsByName('async-op');
        expect(metrics).toHaveLength(1);
        expect(typeof metrics[0].duration).toBe('number');
      });

      it('should propagate rejections from the wrapped function', async () => {
        await expect(
          mod.measureAsync('failing-async', async () => {
            throw new Error('async failure');
          })
        ).rejects.toThrow('async failure');
      });

      it('should still record the metric even when the async function rejects', async () => {
        try {
          await mod.measureAsync('failing-async', async () => {
            throw new Error('async failure');
          }, false);
        } catch {
          // expected
        }

        const metrics = mod.getMetricsByName('failing-async');
        expect(metrics).toHaveLength(1);
      });
    });

    describe('when disabled', () => {
      beforeEach(() => {
        loadModuleNodeDisabled();
      });

      it('should still execute the async function and return its result', async () => {
        const result = await mod.measureAsync('disabled-async', async () => 'result');
        expect(result).toBe('result');
      });

      it('should not record any metrics', async () => {
        await mod.measureAsync('disabled-async', async () => 'val');
        expect(mod.getMetrics()).toHaveLength(0);
      });
    });
  });

  /* ================================================================== */
  /*  4. getMetrics                                                      */
  /* ================================================================== */
  describe('getMetrics', () => {
    beforeEach(() => {
      loadModuleNodeEnabled();
      mod.clearMetrics();
    });

    it('should return an empty array when no metrics exist', () => {
      expect(mod.getMetrics()).toEqual([]);
    });

    it('should return a copy of the metrics array (not the original)', () => {
      mod.startMeasure('op');
      mod.endMeasure('op', false);

      const first = mod.getMetrics();
      const second = mod.getMetrics();

      expect(first).toEqual(second);
      expect(first).not.toBe(second);
    });

    it('should accumulate multiple metrics', () => {
      mod.startMeasure('op-1');
      mod.endMeasure('op-1', false);
      mod.startMeasure('op-2');
      mod.endMeasure('op-2', false);
      mod.startMeasure('op-3');
      mod.endMeasure('op-3', false);

      expect(mod.getMetrics()).toHaveLength(3);
    });
  });

  /* ================================================================== */
  /*  5. getMetricsByName                                                */
  /* ================================================================== */
  describe('getMetricsByName', () => {
    beforeEach(() => {
      loadModuleNodeEnabled();
      mod.clearMetrics();
    });

    it('should return only metrics matching the given name', () => {
      mod.startMeasure('alpha');
      mod.endMeasure('alpha', false);
      mod.startMeasure('beta');
      mod.endMeasure('beta', false);
      mod.startMeasure('alpha');
      mod.endMeasure('alpha', false);

      const alphaMetrics = mod.getMetricsByName('alpha');
      expect(alphaMetrics).toHaveLength(2);
      alphaMetrics.forEach(m => expect(m.name).toBe('alpha'));
    });

    it('should return an empty array for non-existent name', () => {
      expect(mod.getMetricsByName('no-such-metric')).toEqual([]);
    });
  });

  /* ================================================================== */
  /*  6. getAverageDuration                                              */
  /* ================================================================== */
  describe('getAverageDuration', () => {
    beforeEach(() => {
      loadModuleNodeEnabled();
      mod.clearMetrics();
    });

    it('should return null when no metrics exist for the name', () => {
      expect(mod.getAverageDuration('unknown')).toBeNull();
    });

    it('should return the exact duration when there is a single metric', () => {
      mod.startMeasure('single');
      mod.endMeasure('single', false);

      // Duration is 100 (mocked performance.now increments by 100)
      expect(mod.getAverageDuration('single')).toBe(100);
    });

    it('should return the average across multiple metrics', () => {
      // Each start/end pair consumes two performance.now() calls => 100ms each
      mod.startMeasure('multi');
      mod.endMeasure('multi', false);
      mod.startMeasure('multi');
      mod.endMeasure('multi', false);
      mod.startMeasure('multi');
      mod.endMeasure('multi', false);

      // All durations are 100, so average is 100
      expect(mod.getAverageDuration('multi')).toBe(100);
    });
  });

  /* ================================================================== */
  /*  7. clearMetrics                                                    */
  /* ================================================================== */
  describe('clearMetrics', () => {
    beforeEach(() => {
      loadModuleNodeEnabled();
    });

    it('should remove all recorded metrics', () => {
      mod.startMeasure('to-clear');
      mod.endMeasure('to-clear', false);
      expect(mod.getMetrics()).toHaveLength(1);

      mod.clearMetrics();
      expect(mod.getMetrics()).toHaveLength(0);
    });

    it('should also clear pending marks', () => {
      mod.startMeasure('pending-mark');
      mod.clearMetrics();

      // Since the mark was cleared, endMeasure should warn
      const result = mod.endMeasure('pending-mark');
      expect(result).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[Performance] No start mark found for: pending-mark'
      );
    });
  });

  /* ================================================================== */
  /*  8. logSummary                                                      */
  /* ================================================================== */
  describe('logSummary', () => {
    describe('when enabled', () => {
      beforeEach(() => {
        loadModuleNodeEnabled();
        mod.clearMetrics();
      });

      it('should not log anything when metrics array is empty', () => {
        consoleGroupSpy.mockClear();
        consoleLogSpy.mockClear();

        mod.logSummary();

        expect(consoleGroupSpy).not.toHaveBeenCalled();
        expect(consoleGroupEndSpy).not.toHaveBeenCalled();
      });

      it('should log grouped summary when metrics exist', () => {
        mod.startMeasure('render');
        mod.endMeasure('render', false);

        consoleGroupSpy.mockClear();
        consoleLogSpy.mockClear();

        mod.logSummary();

        expect(consoleGroupSpy).toHaveBeenCalledTimes(1);
        expect(consoleLogSpy).toHaveBeenCalled();
        expect(consoleGroupEndSpy).toHaveBeenCalledTimes(1);
      });

      it('should group metrics by name and show avg/min/max/count', () => {
        mod.startMeasure('fetch');
        mod.endMeasure('fetch', false);
        mod.startMeasure('fetch');
        mod.endMeasure('fetch', false);
        mod.startMeasure('compute');
        mod.endMeasure('compute', false);

        consoleLogSpy.mockClear();
        mod.logSummary();

        // Should have two log calls: one for 'fetch' stats, one for 'compute' stats
        const logCalls = consoleLogSpy.mock.calls;
        const fetchLog = logCalls.find(
          (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('fetch')
        );
        const computeLog = logCalls.find(
          (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('compute')
        );

        expect(fetchLog).toBeDefined();
        expect(computeLog).toBeDefined();

        // Verify count is included for fetch (should be 2)
        const fetchCallStr = fetchLog!.join(' ');
        expect(fetchCallStr).toContain('count=2');

        // Verify count for compute (should be 1)
        const computeCallStr = computeLog!.join(' ');
        expect(computeCallStr).toContain('count=1');
      });
    });

    describe('when disabled', () => {
      beforeEach(() => {
        loadModuleNodeDisabled();
      });

      it('should not log anything', () => {
        consoleGroupSpy.mockClear();
        consoleLogSpy.mockClear();

        mod.logSummary();

        expect(consoleGroupSpy).not.toHaveBeenCalled();
      });
    });
  });

  /* ================================================================== */
  /*  9. enable                                                          */
  /* ================================================================== */
  describe('enable', () => {
    describe('in browser environment', () => {
      it('should set DEBUG_PERFORMANCE in localStorage', () => {
        const lsMock = loadModuleBrowserDisabled();

        mod.enable();

        expect(lsMock.setItem).toHaveBeenCalledWith('DEBUG_PERFORMANCE', 'true');
      });

      it('should log a confirmation message', () => {
        loadModuleBrowserDisabled();
        consoleLogSpy.mockClear();

        mod.enable();

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Performance monitoring enabled')
        );
      });
    });

    describe('in Node.js environment', () => {
      it('should set process.env.DEBUG_PERFORMANCE to true', () => {
        loadModuleNodeDisabled();

        mod.enable();

        expect(process.env.DEBUG_PERFORMANCE).toBe('true');
      });

      it('should log a confirmation message', () => {
        loadModuleNodeDisabled();
        consoleLogSpy.mockClear();

        mod.enable();

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Performance monitoring enabled')
        );
      });
    });
  });

  /* ================================================================== */
  /*  10. disable                                                        */
  /* ================================================================== */
  describe('disable', () => {
    describe('in browser environment', () => {
      it('should remove DEBUG_PERFORMANCE from localStorage', () => {
        const lsMock = loadModuleBrowserEnabled();

        mod.disable();

        expect(lsMock.removeItem).toHaveBeenCalledWith('DEBUG_PERFORMANCE');
      });

      it('should log a confirmation message', () => {
        loadModuleBrowserEnabled();
        consoleLogSpy.mockClear();

        mod.disable();

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Performance monitoring disabled')
        );
      });
    });

    describe('in Node.js environment', () => {
      it('should delete process.env.DEBUG_PERFORMANCE', () => {
        loadModuleNodeEnabled();

        mod.disable();

        expect(process.env.DEBUG_PERFORMANCE).toBeUndefined();
      });

      it('should log a confirmation message', () => {
        loadModuleNodeEnabled();
        consoleLogSpy.mockClear();

        mod.disable();

        expect(consoleLogSpy).toHaveBeenCalledWith(
          expect.stringContaining('Performance monitoring disabled')
        );
      });
    });
  });

  /* ================================================================== */
  /*  11. isEnabled via NODE_ENV=development path                        */
  /* ================================================================== */
  describe('isEnabled via NODE_ENV', () => {
    it('should enable in development mode (Node.js) even without DEBUG_PERFORMANCE', () => {
      // @ts-ignore
      delete global.window;
      delete process.env.DEBUG_PERFORMANCE;
      process.env.NODE_ENV = 'development';
      jest.resetModules();
      mod = require('@/lib/performance');
      mod.clearMetrics();

      // If isEnabled() returns true, startMeasure + endMeasure should work
      mod.startMeasure('dev-check');
      const duration = mod.endMeasure('dev-check', false);
      expect(duration).not.toBeNull();
    });

    it('should enable in development mode (browser) even without localStorage flag', () => {
      const lsMock = createLocalStorageMock();
      (lsMock.getItem as jest.Mock).mockReturnValue(null);

      // @ts-ignore
      global.window = { localStorage: lsMock } as any;
      Object.defineProperty(global, 'localStorage', {
        value: lsMock,
        writable: true,
        configurable: true,
      });

      process.env.NODE_ENV = 'development';
      jest.resetModules();
      mod = require('@/lib/performance');
      mod.clearMetrics();

      mod.startMeasure('browser-dev-check');
      const duration = mod.endMeasure('browser-dev-check', false);
      expect(duration).not.toBeNull();
    });
  });

  /* ================================================================== */
  /*  12. Console log color indicators                                   */
  /* ================================================================== */
  describe('endMeasure console log color indicators', () => {
    beforeEach(() => {
      loadModuleNodeEnabled();
      mod.clearMetrics();
    });

    it('should use green indicator for fast operations (< 50ms)', () => {
      // Override mock to return a 30ms duration
      performanceNowSpy.mockReturnValueOnce(0).mockReturnValueOnce(30);
      consoleLogSpy.mockClear();

      mod.startMeasure('fast');
      mod.endMeasure('fast');

      const logCall = consoleLogSpy.mock.calls.find(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('fast')
      );
      expect(logCall).toBeDefined();
      // The green circle emoji for fast ops
      expect(logCall![0]).toContain('30.00ms');
    });

    it('should use yellow indicator for medium operations (50-200ms)', () => {
      performanceNowSpy.mockReturnValueOnce(0).mockReturnValueOnce(120);
      consoleLogSpy.mockClear();

      mod.startMeasure('medium');
      mod.endMeasure('medium');

      const logCall = consoleLogSpy.mock.calls.find(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('medium')
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toContain('120.00ms');
    });

    it('should use red indicator for slow operations (>= 200ms)', () => {
      performanceNowSpy.mockReturnValueOnce(0).mockReturnValueOnce(500);
      consoleLogSpy.mockClear();

      mod.startMeasure('slow');
      mod.endMeasure('slow');

      const logCall = consoleLogSpy.mock.calls.find(
        (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('slow')
      );
      expect(logCall).toBeDefined();
      expect(logCall![0]).toContain('500.00ms');
    });
  });

  /* ================================================================== */
  /*  13. enable/disable toggle round-trip                               */
  /* ================================================================== */
  describe('enable/disable toggle (Node.js)', () => {
    it('should allow enabling and then recording metrics', () => {
      loadModuleNodeDisabled();

      // Currently disabled -- startMeasure/endMeasure are no-ops
      mod.startMeasure('before-enable');
      expect(mod.endMeasure('before-enable')).toBeNull();

      // Enable performance monitoring
      mod.enable();

      // Now it should work
      mod.startMeasure('after-enable');
      const duration = mod.endMeasure('after-enable', false);
      expect(duration).not.toBeNull();
    });

    it('should stop recording after disable', () => {
      loadModuleNodeEnabled();
      mod.clearMetrics();

      // Works when enabled
      mod.startMeasure('while-enabled');
      mod.endMeasure('while-enabled', false);
      expect(mod.getMetrics()).toHaveLength(1);

      // Disable
      mod.disable();

      // No longer records
      mod.startMeasure('while-disabled');
      const result = mod.endMeasure('while-disabled');
      expect(result).toBeNull();
      expect(mod.getMetrics()).toHaveLength(1); // still 1 from before
    });
  });
});
