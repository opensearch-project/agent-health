/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { useBenchmarkCancellation } from '@/hooks/useBenchmarkCancellation';
import { cancelBenchmarkRun } from '@/services/client/benchmarkApi';

// Mock the benchmarkApi module
jest.mock('@/services/client/benchmarkApi', () => ({
  cancelBenchmarkRun: jest.fn(),
}));

const mockCancelBenchmarkRun = cancelBenchmarkRun as jest.MockedFunction<
  typeof cancelBenchmarkRun
>;

describe('useBenchmarkCancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initial state', () => {
    it('should have cancellingRunId as null initially', () => {
      const { result } = renderHook(() => useBenchmarkCancellation());
      expect(result.current.cancellingRunId).toBeNull();
    });
  });

  describe('isCancelling', () => {
    it('should return false when no run is being cancelled', () => {
      const { result } = renderHook(() => useBenchmarkCancellation());
      expect(result.current.isCancelling('run-123')).toBe(false);
    });

    it('should return true when the specific run is being cancelled', async () => {
      mockCancelBenchmarkRun.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(true), 100))
      );

      const { result } = renderHook(() => useBenchmarkCancellation());

      // Start cancellation without awaiting
      act(() => {
        result.current.handleCancelRun('bench-1', 'run-123');
      });

      // Check isCancelling during the API call
      expect(result.current.isCancelling('run-123')).toBe(true);
      expect(result.current.isCancelling('run-456')).toBe(false);

      // Wait for the API call to complete
      await waitFor(() => {
        expect(result.current.cancellingRunId).toBeNull();
      });
    });
  });

  describe('handleCancelRun', () => {
    it('should call cancelBenchmarkRun with correct arguments', async () => {
      mockCancelBenchmarkRun.mockResolvedValue(true);

      const { result } = renderHook(() => useBenchmarkCancellation());

      await act(async () => {
        await result.current.handleCancelRun('bench-123', 'run-456');
      });

      expect(mockCancelBenchmarkRun).toHaveBeenCalledWith('bench-123', 'run-456');
    });

    it('should set cancellingRunId during API call and clear it after', async () => {
      let resolvePromise: (value: boolean) => void;
      mockCancelBenchmarkRun.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          })
      );

      const { result } = renderHook(() => useBenchmarkCancellation());

      // Start cancellation
      let cancelPromise: Promise<void>;
      act(() => {
        cancelPromise = result.current.handleCancelRun('bench-1', 'run-123');
      });

      // During API call, cancellingRunId should be set
      expect(result.current.cancellingRunId).toBe('run-123');

      // Resolve the API call
      await act(async () => {
        resolvePromise!(true);
        await cancelPromise;
      });

      // After API call, cancellingRunId should be cleared
      expect(result.current.cancellingRunId).toBeNull();
    });

    it('should call onSuccess callback after successful cancel', async () => {
      mockCancelBenchmarkRun.mockResolvedValue(true);
      const onSuccess = jest.fn();

      const { result } = renderHook(() => useBenchmarkCancellation());

      await act(async () => {
        await result.current.handleCancelRun('bench-1', 'run-123', onSuccess);
      });

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('should call async onSuccess callback and wait for it', async () => {
      mockCancelBenchmarkRun.mockResolvedValue(true);
      const onSuccess = jest.fn().mockResolvedValue(undefined);

      const { result } = renderHook(() => useBenchmarkCancellation());

      await act(async () => {
        await result.current.handleCancelRun('bench-1', 'run-123', onSuccess);
      });

      expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('should handle API errors gracefully', async () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation();
      mockCancelBenchmarkRun.mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useBenchmarkCancellation());

      await act(async () => {
        await result.current.handleCancelRun('bench-1', 'run-123');
      });

      // Should log the error
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to cancel run:',
        expect.any(Error)
      );

      // Should still clear cancellingRunId
      expect(result.current.cancellingRunId).toBeNull();

      consoleError.mockRestore();
    });

    it('should not call onSuccess when API fails', async () => {
      jest.spyOn(console, 'error').mockImplementation();
      mockCancelBenchmarkRun.mockRejectedValue(new Error('Network error'));
      const onSuccess = jest.fn();

      const { result } = renderHook(() => useBenchmarkCancellation());

      await act(async () => {
        await result.current.handleCancelRun('bench-1', 'run-123', onSuccess);
      });

      expect(onSuccess).not.toHaveBeenCalled();
    });

    it('should work without onSuccess callback', async () => {
      mockCancelBenchmarkRun.mockResolvedValue(true);

      const { result } = renderHook(() => useBenchmarkCancellation());

      // Should not throw
      await act(async () => {
        await result.current.handleCancelRun('bench-1', 'run-123');
      });

      expect(mockCancelBenchmarkRun).toHaveBeenCalled();
    });
  });
});
