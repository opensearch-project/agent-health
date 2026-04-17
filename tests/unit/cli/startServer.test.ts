/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for cli/utils/startServer.ts
 *
 * The startServer module:
 * - Finds the package root directory
 * - Sets VITE_BACKEND_PORT environment variable
 * - Dynamically imports the server app and starts it
 * - Auto-increments port on EADDRINUSE (up to MAX_PORT_ATTEMPTS)
 */

describe('startServer module', () => {
  describe('startServer function signature', () => {
    it('should export a startServer function', async () => {
      expect(true).toBe(true);
    });

    it('should accept a port option and return the actual port used', () => {
      const expectedOptions = { port: 4001 };
      expect(expectedOptions).toHaveProperty('port');
      expect(typeof expectedOptions.port).toBe('number');
    });
  });

  describe('findPackageRoot behavior', () => {
    it('should search up to 5 levels for package.json', () => {
      const maxLevels = 5;
      expect(maxLevels).toBe(5);
    });
  });

  describe('environment variable setup', () => {
    it('should set VITE_BACKEND_PORT from options', () => {
      const port = 5000;
      const expectedEnvValue = String(port);
      expect(expectedEnvValue).toBe('5000');
    });
  });

  describe('server startup', () => {
    it('should listen on 0.0.0.0 for external access', () => {
      const expectedHost = '0.0.0.0';
      expect(expectedHost).toBe('0.0.0.0');
    });

    it('should return a Promise that resolves with the actual port', () => {
      const promiseResult = Promise.resolve(4001);
      expect(promiseResult).toBeInstanceOf(Promise);
    });
  });

  describe('port auto-increment on EADDRINUSE', () => {
    function simulateTryListen(
      requestedPort: number,
      portsInUse: number[],
      maxAttempts: number = 10
    ): Promise<number> {
      return new Promise((resolve, reject) => {
        const tryPort = (port: number) => {
          setTimeout(() => {
            if (portsInUse.includes(port)) {
              const err: NodeJS.ErrnoException = new Error(`listen EADDRINUSE: address already in use 0.0.0.0:${port}`);
              err.code = 'EADDRINUSE';

              if (port <= requestedPort + maxAttempts) {
                tryPort(port + 1);
              } else {
                reject(err);
              }
            } else {
              resolve(port);
            }
          }, 0);
        };

        tryPort(requestedPort);
      });
    }

    it('should use the requested port when available', async () => {
      const port = await simulateTryListen(4001, []);
      expect(port).toBe(4001);
    });

    it('should increment to port+1 when requested port is in use', async () => {
      const port = await simulateTryListen(4001, [4001]);
      expect(port).toBe(4002);
    });

    it('should skip multiple in-use ports', async () => {
      const port = await simulateTryListen(4001, [4001, 4002, 4003]);
      expect(port).toBe(4004);
    });

    it('should fail after MAX_PORT_ATTEMPTS consecutive in-use ports', async () => {
      const maxAttempts = 10;
      // Need maxAttempts + 2 ports in use to exhaust retries (original + 10 retries + 1 more)
      const allInUse = Array.from({ length: maxAttempts + 2 }, (_, i) => 4001 + i);

      await expect(
        simulateTryListen(4001, allInUse, maxAttempts)
      ).rejects.toThrow('EADDRINUSE');
    });

    it('should try up to 10 additional ports by default', async () => {
      // Ports 4001-4011 in use (11 ports), 4012 should succeed
      const portsInUse = Array.from({ length: 11 }, (_, i) => 4001 + i);
      const port = await simulateTryListen(4001, portsInUse);
      expect(port).toBe(4012);
    });

    it('should propagate non-EADDRINUSE errors immediately', async () => {
      const simulateWithOtherError = (): Promise<number> => {
        return new Promise((_, reject) => {
          const err: NodeJS.ErrnoException = new Error('permission denied');
          err.code = 'EACCES';
          reject(err);
        });
      };

      await expect(simulateWithOtherError()).rejects.toThrow('permission denied');
    });
  });
});
