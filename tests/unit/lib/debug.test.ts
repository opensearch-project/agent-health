/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDebugEnabled, setDebugEnabled, debug } from '@/lib/debug';

describe('Debug Utility', () => {
  let consoleDebugSpy: jest.SpyInstance;
  const originalLocalStorage = global.localStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});

    // Reset localStorage mock
    const localStorageMock: Storage = {
      getItem: jest.fn(),
      setItem: jest.fn(),
      removeItem: jest.fn(),
      clear: jest.fn(),
      length: 0,
      key: jest.fn(),
    };
    Object.defineProperty(global, 'localStorage', {
      value: localStorageMock,
      writable: true,
    });
  });

  afterEach(() => {
    consoleDebugSpy.mockRestore();
    Object.defineProperty(global, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
  });

  describe('isDebugEnabled', () => {
    it('should return true when localStorage has debug set to true', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');

      expect(isDebugEnabled()).toBe(true);
      expect(localStorage.getItem).toHaveBeenCalledWith('agenteval_debug');
    });

    it('should return false when localStorage has debug set to false', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('false');

      expect(isDebugEnabled()).toBe(false);
    });

    it('should return false when localStorage has no debug setting', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue(null);

      expect(isDebugEnabled()).toBe(false);
    });

    it('should return false when localStorage throws an error', () => {
      (localStorage.getItem as jest.Mock).mockImplementation(() => {
        throw new Error('localStorage not available');
      });

      expect(isDebugEnabled()).toBe(false);
    });
  });

  describe('setDebugEnabled', () => {
    it('should set debug to true in localStorage', () => {
      setDebugEnabled(true);

      expect(localStorage.setItem).toHaveBeenCalledWith('agenteval_debug', 'true');
    });

    it('should set debug to false in localStorage', () => {
      setDebugEnabled(false);

      expect(localStorage.setItem).toHaveBeenCalledWith('agenteval_debug', 'false');
    });
  });

  describe('debug', () => {
    it('should log to console.debug when debug is enabled', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');

      debug('TestModule', 'test message', { data: 123 });

      expect(consoleDebugSpy).toHaveBeenCalledWith('[TestModule]', 'test message', { data: 123 });
    });

    it('should not log when debug is disabled', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('false');

      debug('TestModule', 'test message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });

    it('should handle multiple arguments', () => {
      (localStorage.getItem as jest.Mock).mockReturnValue('true');

      debug('Module', 'arg1', 'arg2', 123, { obj: true });

      expect(consoleDebugSpy).toHaveBeenCalledWith('[Module]', 'arg1', 'arg2', 123, { obj: true });
    });

    it('should not log when localStorage is not available', () => {
      (localStorage.getItem as jest.Mock).mockImplementation(() => {
        throw new Error('localStorage not available');
      });

      debug('TestModule', 'test message');

      expect(consoleDebugSpy).not.toHaveBeenCalled();
    });
  });
});
