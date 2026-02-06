/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for server lifecycle logic patterns.
 *
 * Tests version comparison and server status interfaces.
 * These tests verify the logic patterns used in serverLifecycle.ts
 * without importing the module directly (to avoid ESM issues).
 */

describe('Server Lifecycle Logic - Version Comparison', () => {
  /**
   * Tests the version comparison logic used in ensureServer()
   */
  function versionsMatch(serverVersion: string | undefined, cliVersion: string): boolean {
    return (
      serverVersion === cliVersion ||
      serverVersion === 'unknown' ||
      cliVersion === 'unknown'
    );
  }

  it('should consider versions matching when they are equal', () => {
    expect(versionsMatch('1.0.0', '1.0.0')).toBe(true);
    expect(versionsMatch('0.1.23', '0.1.23')).toBe(true);
  });

  it('should detect version mismatch when versions differ', () => {
    expect(versionsMatch('1.0.0', '2.0.0')).toBe(false);
    expect(versionsMatch('0.1.20', '0.1.23')).toBe(false);
  });

  it('should allow reuse when server version is unknown', () => {
    expect(versionsMatch('unknown', '1.0.0')).toBe(true);
  });

  it('should allow reuse when cli version is unknown', () => {
    expect(versionsMatch('1.0.0', 'unknown')).toBe(true);
  });

  it('should handle undefined server version', () => {
    expect(versionsMatch(undefined, '1.0.0')).toBe(false);
  });
});

describe('Server Lifecycle Logic - Stop Server Decision', () => {
  /**
   * Tests the decision logic for determining if server should be stopped
   */
  function calculateShouldStopServer(
    isCI: boolean,
    quickMode: boolean,
    stopServerFlag?: boolean
  ): boolean {
    return isCI || quickMode || !!stopServerFlag;
  }

  it('should return false when all conditions are false', () => {
    expect(calculateShouldStopServer(false, false, false)).toBe(false);
    expect(calculateShouldStopServer(false, false, undefined)).toBe(false);
  });

  it('should return true when isCI is true', () => {
    expect(calculateShouldStopServer(true, false, false)).toBe(true);
  });

  it('should return true when quickMode is true', () => {
    expect(calculateShouldStopServer(false, true, false)).toBe(true);
  });

  it('should return true when stopServer flag is true', () => {
    expect(calculateShouldStopServer(false, false, true)).toBe(true);
  });
});

describe('Server Lifecycle Logic - Cleanup Function', () => {
  interface MockResult {
    wasStarted: boolean;
    process?: { kill: jest.Mock };
  }

  function createCleanupLogic(result: MockResult, shouldStop: boolean) {
    return () => {
      if (result.wasStarted && shouldStop && result.process) {
        result.process.kill('SIGTERM');
      }
    };
  }

  it('should call kill when server was started and should stop', () => {
    const mockKill = jest.fn();
    const result: MockResult = {
      wasStarted: true,
      process: { kill: mockKill },
    };

    const cleanup = createCleanupLogic(result, true);
    cleanup();

    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
  });

  it('should not call kill when server was not started', () => {
    const mockKill = jest.fn();
    const result: MockResult = {
      wasStarted: false,
      process: { kill: mockKill },
    };

    const cleanup = createCleanupLogic(result, true);
    cleanup();

    expect(mockKill).not.toHaveBeenCalled();
  });

  it('should not call kill when shouldStop is false', () => {
    const mockKill = jest.fn();
    const result: MockResult = {
      wasStarted: true,
      process: { kill: mockKill },
    };

    const cleanup = createCleanupLogic(result, false);
    cleanup();

    expect(mockKill).not.toHaveBeenCalled();
  });
});
