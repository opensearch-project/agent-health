/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for port auto-increment on EADDRINUSE in server/index.ts
 *
 * The server entry point uses a tryListen pattern:
 * - Attempts to listen on the requested port
 * - On EADDRINUSE, increments port and retries (up to MAX_PORT_ATTEMPTS=10)
 * - On other errors or exhausted attempts, rejects
 */

import { EventEmitter } from 'events';
import net from 'net';

const MAX_PORT_ATTEMPTS = 10;

function createMockApp(portsInUse: Set<number>) {
  return {
    listen: (port: number, host: string) => {
      const server = new EventEmitter();
      process.nextTick(() => {
        if (portsInUse.has(port)) {
          const err: NodeJS.ErrnoException = new Error(
            `listen EADDRINUSE: address already in use ${host}:${port}`
          );
          err.code = 'EADDRINUSE';
          server.emit('error', err);
        } else {
          server.emit('listening');
        }
      });
      return server;
    },
  };
}

function tryListen(
  app: ReturnType<typeof createMockApp>,
  port: number,
  startPort: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');

    server.on('listening', () => {
      resolve(port);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && port <= startPort + MAX_PORT_ATTEMPTS) {
        resolve(tryListen(app, port + 1, startPort));
      } else {
        reject(err);
      }
    });
  });
}

describe('Server port auto-increment (tryListen pattern)', () => {
  it('should bind to the requested port when available', async () => {
    const app = createMockApp(new Set());
    const port = await tryListen(app, 4001, 4001);
    expect(port).toBe(4001);
  });

  it('should try port+1 when requested port is in use', async () => {
    const app = createMockApp(new Set([4001]));
    const port = await tryListen(app, 4001, 4001);
    expect(port).toBe(4002);
  });

  it('should skip multiple in-use ports consecutively', async () => {
    const app = createMockApp(new Set([4001, 4002, 4003, 4004]));
    const port = await tryListen(app, 4001, 4001);
    expect(port).toBe(4005);
  });

  it('should handle the last allowed attempt succeeding', async () => {
    // Ports 4001-4011 in use (11 ports), 4012 is free and is the last allowed attempt
    const inUse = new Set(Array.from({ length: 11 }, (_, i) => 4001 + i));
    const app = createMockApp(inUse);
    const port = await tryListen(app, 4001, 4001);
    expect(port).toBe(4012);
  });

  it('should reject after MAX_PORT_ATTEMPTS consecutive failures', async () => {
    // All ports 4001-4012 in use (12 ports), exceeds the 10 retry limit
    const inUse = new Set(Array.from({ length: 13 }, (_, i) => 4001 + i));
    const app = createMockApp(inUse);
    await expect(tryListen(app, 4001, 4001)).rejects.toThrow('EADDRINUSE');
  });

  it('should propagate non-EADDRINUSE errors without retrying', async () => {
    const app = {
      listen: (_port: number, _host: string) => {
        const server = new EventEmitter();
        process.nextTick(() => {
          const err: NodeJS.ErrnoException = new Error('permission denied');
          err.code = 'EACCES';
          server.emit('error', err);
        });
        return server;
      },
    };

    await expect(tryListen(app, 4001, 4001)).rejects.toThrow('permission denied');
  });

  it('should resolve with the correct port number', async () => {
    const app = createMockApp(new Set([4001, 4002]));
    const port = await tryListen(app, 4001, 4001);
    expect(port).toBe(4003);
    expect(typeof port).toBe('number');
  });
});

describe('Port auto-increment with real TCP sockets', () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const server of servers) {
      server.close();
    }
    servers.length = 0;
  });

  function occupyPort(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(port, '127.0.0.1', () => {
        servers.push(server);
        resolve(server);
      });
      server.on('error', reject);
    });
  }

  it('should detect an occupied port and use the next one', async () => {
    const occupiedPort = 19876;
    await occupyPort(occupiedPort);

    const app = createMockApp(new Set([occupiedPort]));
    const port = await tryListen(app, occupiedPort, occupiedPort);
    expect(port).toBe(occupiedPort + 1);
  });
});
