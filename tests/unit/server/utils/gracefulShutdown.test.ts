/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * server/utils/gracefulShutdown.ts against a REAL http.Server (no http mocks):
 * accepting stops immediately, cleanup/draining finish before exit, exit is
 * called exactly once, and the deadline bounds hung cleanup / stuck
 * connections (which `server.close()` alone would wait on forever).
 */

import { Agent, createServer, request as httpRequest, type Server } from 'http';
import { connect, type Socket } from 'net';
import { installGracefulShutdown, type GracefulShutdownHandle } from '@/server/utils/gracefulShutdown';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
}

function connectRefused(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(undefined); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code));
  });
}

function openHeldRequest(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      // Headers never finish → request never dispatched → not an idle socket.
      socket.write('GET /slow HTTP/1.1\r\nHost: x\r\n');
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

describe('installGracefulShutdown (real http.Server)', () => {
  let server: Server;
  let handle: GracefulShutdownHandle | undefined;
  let exits: number[];
  let logs: string[];
  let keepAliveAgent: Agent | undefined;
  const sockets = new Set<Socket>();

  beforeEach(() => {
    exits = [];
    logs = [];
    server = createServer((_req, res) => res.end('ok'));
    server.keepAliveTimeout = 60_000;
  });

  afterEach(async () => {
    handle?.dispose();
    handle = undefined;
    keepAliveAgent?.destroy();
    keepAliveAgent = undefined;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
  });

  const install = (options: Parameters<typeof installGracefulShutdown>[1] = {}) => {
    handle = installGracefulShutdown(server, {
      log: (m) => logs.push(m),
      exit: (code) => exits.push(code),
      ...options,
    });
    return handle;
  };

  it('stops accepting, completes cleanup and draining, then exits 0 once', async () => {
    const port = await listen(server);
    const order: string[] = [];
    const h = install({
      cleanup: [
        async () => { await sleep(20); order.push('async-hook'); },
        () => { expect(server.listening).toBe(false); order.push('sync-hook'); },
      ],
      exit: (code) => { order.push('exit'); exits.push(code); },
    });
    server.on('close', () => order.push('listener-closed'));

    const before = process.listenerCount('SIGTERM');
    await h.shutdown('SIGTERM');
    await sleep(20);

    expect(order).toHaveLength(4);
    expect(order).toEqual(expect.arrayContaining(['sync-hook', 'async-hook', 'listener-closed']));
    expect(order[order.length - 1]).toBe('exit');
    expect(server.listening).toBe(false);
    expect(await connectRefused(port)).toBe('ECONNREFUSED');
    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('Received SIGTERM');
    expect(logs.join('\n')).toContain('Server closed.');
    // Still registered until dispose(); a second signal is a no-op.
    expect(process.listenerCount('SIGTERM')).toBe(before);
    await h.shutdown('SIGINT');
    expect(exits).toEqual([0]);
  });

  it('refuses new connections while a cleanup hook is still pending', async () => {
    const port = await listen(server);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const h = install({ cleanup: [async () => { entered(); await pending; }] });
    const shutdown = h.shutdown('SIGTERM');
    try {
      await started;
      // A real new TCP connection, not a mocked Server.close/listening flag.
      expect(await connectRefused(port)).toBe('ECONNREFUSED');
      expect(exits).toEqual([]); // Do not exit before the pending cleanup finishes.
    } finally {
      release();
      await shutdown;
    }
  });

  it('a rejected cleanup hook is logged and does not prevent close/exit', async () => {
    await listen(server);
    const h = install({ cleanup: [() => { throw new Error('flush boom'); }] });
    await h.shutdown('SIGTERM');
    await sleep(20);
    expect(logs.join('\n')).toContain('Shutdown cleanup step failed: flush boom');
    expect(server.listening).toBe(false);
    expect(exits).toEqual([0]);
  });

  it('a hook rejecting with a non-Error value is logged via String(reason)', async () => {
    await listen(server);
    const h = install({ cleanup: [() => Promise.reject('plain string reason'), () => Promise.reject({ code: 'EOBJ' })] });
    await h.shutdown('SIGTERM');
    await sleep(20);
    const joined = logs.join('\n');
    expect(joined).toContain('Shutdown cleanup step failed: plain string reason');
    expect(joined).toContain('Shutdown cleanup step failed: [object Object]');
    expect(server.listening).toBe(false);
    expect(exits).toEqual([0]);
  });

  it('with no options at all, the defaults log through console.log and exit through process.exit(0)', async () => {
    await listen(server);
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    // process.exit would end the jest worker; observe it instead. The real
    // termination claim is proven by gracefulShutdown.realProcess.test.ts.
    const processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      handle = installGracefulShutdown(server);
      await handle.shutdown('SIGTERM');
      await sleep(20);
      expect(server.listening).toBe(false);
      expect(processExit).toHaveBeenCalledTimes(1);
      expect(processExit).toHaveBeenCalledWith(0);
      const logged = consoleLog.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('Received SIGTERM, shutting down gracefully...');
      expect(logged).toContain('Server closed.');
      expect(exits).toEqual([]); // nothing injected, nothing else called
    } finally {
      consoleLog.mockRestore();
      processExit.mockRestore();
    }
  });

  it('closes idle keep-alive connections so close() does not wait for keepAliveTimeout', async () => {
    const port = await listen(server);
    // Node 18's global agent does not retain idle sockets; a Connection header
    // alone cannot make it do so. Own the fixture's keep-alive agent explicitly.
    keepAliveAgent = new Agent({ keepAlive: true });
    const agentSocket = await new Promise<Socket>((resolve, reject) => {
      const req = httpRequest({ port, host: '127.0.0.1', path: '/', agent: keepAliveAgent }, (res) => {
        res.resume();
        res.on('end', () => resolve(req.socket as Socket));
      });
      req.on('error', reject);
      req.end();
    });
    sockets.add(agentSocket);
    expect(agentSocket.destroyed).toBe(false);

    const socketClosed = new Promise<void>((resolve) => agentSocket.once('close', resolve));
    const h = install({ timeoutMs: 10_000 });
    const started = Date.now();
    await h.shutdown('SIGTERM');
    await socketClosed;
    await sleep(20);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(server.listening).toBe(false);
    expect(exits).toEqual([0]);
    expect(logs.join('\n')).not.toContain('did not finish');
  });

  it('a hung cleanup hook cannot hold the process: deadline exits and destroys connections', async () => {
    const port = await listen(server);
    const held = await openHeldRequest(port);
    sockets.add(held);
    const h = install({ cleanup: [() => new Promise<void>(() => { /* never resolves */ })], timeoutMs: 150 });

    void h.shutdown('SIGTERM');
    const heldClosed = new Promise<void>((resolve) => held.once('close', resolve));
    await sleep(400);

    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('did not finish within 150ms');
    await heldClosed;
    expect(held.destroyed).toBe(true);
    // Even with a hung cleanup, the listener stopped accepting immediately.
    expect(server.listening).toBe(false);
    expect(await connectRefused(port)).toBe('ECONNREFUSED');
  });

  it('an active (in-flight) connection cannot hold the process past the deadline', async () => {
    const port = await listen(server);
    const held = await openHeldRequest(port);
    sockets.add(held);
    const h = install({ timeoutMs: 150 });

    const started = Date.now();
    void h.shutdown('SIGTERM');
    await new Promise<void>((resolve) => held.once('close', resolve));
    await sleep(20);

    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exits).toEqual([0]);
    expect(logs.join('\n')).toContain('did not finish within 150ms');
    expect(await connectRefused(port)).toBe('ECONNREFUSED');
  });

  it('registers SIGTERM+SIGINT listeners and dispose() removes exactly those', () => {
    const term = process.listenerCount('SIGTERM');
    const int = process.listenerCount('SIGINT');
    const h = install();
    expect(process.listenerCount('SIGTERM')).toBe(term + 1);
    expect(process.listenerCount('SIGINT')).toBe(int + 1);
    h.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(term);
    expect(process.listenerCount('SIGINT')).toBe(int);
    handle = undefined;
  });

  it('a real signal listener triggers the sequence (process.emit, no exit by default swap)', async () => {
    await listen(server);
    const hook = jest.fn();
    install({ cleanup: [hook] });
    process.emit('SIGTERM' as any, 'SIGTERM' as any);
    await sleep(50);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
    expect(exits).toEqual([0]);
  });
});
