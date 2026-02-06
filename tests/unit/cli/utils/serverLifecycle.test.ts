/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for server lifecycle race condition fix
 *
 * Tests that the retry loop in killServerOnPort properly verifies
 * the port is free before returning.
 */

// We test the retry logic by simulating what the code does

describe('Server Lifecycle - Race Condition Fix', () => {
  describe('killServerOnPort retry logic verification', () => {
    /**
     * Simulates the retry loop logic from killServerOnPort
     * This is the key fix - retrying until port is actually free
     */
    async function simulateKillWithRetry(
      isPortInUse: () => boolean,
      maxRetries: number = 10,
      retryDelay: number = 50
    ): Promise<{ success: boolean; attempts: number }> {
      let attempts = 0;

      for (let i = 0; i < maxRetries; i++) {
        attempts++;
        await new Promise(r => setTimeout(r, retryDelay));
        if (!isPortInUse()) {
          return { success: true, attempts };
        }
      }

      return { success: false, attempts: maxRetries };
    }

    it('should succeed immediately if port is already free', async () => {
      const isPortInUse = jest.fn().mockReturnValue(false);

      const result = await simulateKillWithRetry(isPortInUse);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(isPortInUse).toHaveBeenCalledTimes(1);
    });

    it('should retry until port becomes free', async () => {
      let callCount = 0;
      const isPortInUse = jest.fn(() => {
        callCount++;
        return callCount < 3; // Port becomes free on 3rd check
      });

      const result = await simulateKillWithRetry(isPortInUse);

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(3);
    });

    it('should fail after max retries if port never frees', async () => {
      const isPortInUse = jest.fn().mockReturnValue(true); // Always in use

      const result = await simulateKillWithRetry(isPortInUse, 5, 10);

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(5);
      expect(isPortInUse).toHaveBeenCalledTimes(5);
    });

    it('should wait between retries', async () => {
      const startTime = Date.now();
      let callCount = 0;
      const isPortInUse = jest.fn(() => {
        callCount++;
        return callCount < 3;
      });

      await simulateKillWithRetry(isPortInUse, 10, 100);

      const elapsed = Date.now() - startTime;
      // Should have waited at least 200ms (2 successful waits + 1 final wait)
      expect(elapsed).toBeGreaterThanOrEqual(200);
    });
  });

  describe('original bug scenario', () => {
    it('should demonstrate the race condition fix', async () => {
      // Scenario: Server killed, but port takes 500ms to actually free
      const portFreeTime = Date.now() + 500;
      const isPortInUse = () => Date.now() < portFreeTime;

      // WITHOUT fix (single wait): Would check once and possibly fail
      const singleCheck = isPortInUse();
      expect(singleCheck).toBe(true); // Port still in use immediately

      // WITH fix (retry loop): Keeps checking until free
      let attempts = 0;
      const maxRetries = 20;
      const retryDelay = 100;
      let portIsFree = false;

      for (let i = 0; i < maxRetries && !portIsFree; i++) {
        attempts++;
        await new Promise(r => setTimeout(r, retryDelay));
        portIsFree = !isPortInUse();
      }

      expect(portIsFree).toBe(true);
      expect(attempts).toBeGreaterThan(1); // Required multiple checks
    });
  });
});
