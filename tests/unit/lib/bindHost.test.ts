/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bind-address resolution for every server entry point (#622).
 *
 * The second block uses REAL sockets (`http`/`net`, no mocks) to pin down the
 * `localhost` → `::1` resolution question: a v4-only bind refuses `::1`
 * whether it is `127.0.0.1` or `0.0.0.0`, so moving the default to loopback
 * changes nothing for clients that dial `localhost`; they rely on Node's
 * default `autoSelectFamily` fallback either way (Node ≥20; this package
 * requires ≥22), and a client that dials `127.0.0.1` explicitly (Playwright,
 * the integration suites, reverse proxies) bypasses the resolver entirely.
 * The CLI keeps dialing `localhost` on purpose: the printed links share the
 * browser origin (localStorage prefs, theme) with the auto-opened UI.
 *
 * The host's resolver cannot be reconfigured from a test, so the `::1`-first
 * ordering is injected through Node's standard `lookup` option — the socket,
 * connect and fallback paths are the real ones.
 */

import { createServer, get as httpGet, type Server } from 'http';
import { connect as netConnect } from 'net';
import {
  DEFAULT_BIND_HOST,
  bindUrl,
  hostEnvIgnoredNotice,
  isLoopbackHost,
  nonLoopbackBindWarning,
  resolveBindHost,
} from '../../../lib/bindHost';

describe('resolveBindHost', () => {
  it('defaults to loopback when neither --host nor AH_HOST is set', () => {
    expect(resolveBindHost(undefined, {})).toBe('127.0.0.1');
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
  });

  it('honours AH_HOST from the environment', () => {
    expect(resolveBindHost(undefined, { AH_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(resolveBindHost(undefined, { AH_HOST: ' :: ' })).toBe('::');
  });

  it('treats a blank AH_HOST as unset', () => {
    expect(resolveBindHost(undefined, { AH_HOST: '' })).toBe('127.0.0.1');
    expect(resolveBindHost(undefined, { AH_HOST: '   ' })).toBe('127.0.0.1');
  });

  it('lets --host override AH_HOST', () => {
    expect(resolveBindHost('10.0.0.5', { AH_HOST: '0.0.0.0' })).toBe('10.0.0.5');
    expect(resolveBindHost('  ', { AH_HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  it('ignores the generic HOST variable — an inherited HOST=0.0.0.0 must not widen the bind', () => {
    expect(resolveBindHost(undefined, { HOST: '0.0.0.0' })).toBe('127.0.0.1');
    expect(resolveBindHost(undefined, { HOST: 'ci-runner-42' })).toBe('127.0.0.1');
    expect(resolveBindHost(undefined, { HOST: '0.0.0.0', AH_HOST: '::' })).toBe('::');
  });
});

describe('hostEnvIgnoredNotice', () => {
  it('names the ignored non-loopback HOST and the variables that do work', () => {
    const notice = hostEnvIgnoredNotice(undefined, { HOST: '0.0.0.0' });
    expect(notice).toContain('HOST=0.0.0.0 is ignored');
    expect(notice).toContain('AH_HOST');
    expect(notice).toContain('--host');
    expect(notice).toContain('127.0.0.1');
  });

  it('is silent when HOST is unset, blank, loopback, or the bind was set explicitly', () => {
    expect(hostEnvIgnoredNotice(undefined, {})).toBeUndefined();
    expect(hostEnvIgnoredNotice(undefined, { HOST: '  ' })).toBeUndefined();
    expect(hostEnvIgnoredNotice(undefined, { HOST: '127.0.0.1' })).toBeUndefined();
    expect(hostEnvIgnoredNotice(undefined, { HOST: '0.0.0.0', AH_HOST: '0.0.0.0' })).toBeUndefined();
    expect(hostEnvIgnoredNotice('0.0.0.0', { HOST: '0.0.0.0' })).toBeUndefined();
  });
});

describe('isLoopbackHost / nonLoopbackBindWarning', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1'])(
    'is silent for loopback %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
      expect(nonLoopbackBindWarning(host)).toBeUndefined();
    },
  );

  it.each(['0.0.0.0', '::', '10.0.0.5', '192.168.1.20', 'my-host.example'])(
    'warns for non-loopback %s and names the bind, the missing auth and the fix',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
      const warning = nonLoopbackBindWarning(host);
      expect(warning).toContain(`listening on ${host}`);
      expect(warning).toMatch(/unauthenticated/);
      expect(warning).toMatch(/credentials/);
      expect(warning).toContain('127.0.0.1');
    },
  );
});

describe('bindUrl', () => {
  it('prints the bound address, bracketing IPv6 literals', () => {
    expect(bindUrl('127.0.0.1', 4001)).toBe('http://127.0.0.1:4001');
    expect(bindUrl('0.0.0.0', 4002)).toBe('http://0.0.0.0:4002');
    expect(bindUrl('::', 4003)).toBe('http://[::]:4003');
    expect(bindUrl('::1', 4004)).toBe('http://[::1]:4004');
    expect(bindUrl('[::1]', 4005)).toBe('http://[::1]:4005');
  });
});

describe('localhost → ::1-first resolution against a v4-only bind (real sockets)', () => {
  /** Resolver that answers like a host with `::1 localhost` listed first. */
  const v6First = (
    _host: string,
    opts: { all?: boolean },
    cb: (...args: any[]) => void,
  ) => {
    if (opts.all) return cb(null, [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]);
    return cb(null, '::1', 6);
  };

  function listen(bind: string): Promise<{ server: Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = createServer((_req, res) => res.end('ok'));
      server.once('error', reject);
      server.listen(0, bind, () => resolve({ server, port: (server.address() as { port: number }).port }));
    });
  }

  function dial(opts: Record<string, unknown>): Promise<number | string> {
    return new Promise((resolve) => {
      const req = httpGet({ path: '/', agent: false, ...opts }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
    });
  }

  function rawConnect(host: string, port: number): Promise<string> {
    return new Promise((resolve) => {
      const socket = netConnect({ host, port });
      socket.on('connect', () => { socket.destroy(); resolve('connected'); });
      socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
  }

  it.each(['127.0.0.1', '0.0.0.0'])('bind %s: ::1 is refused, localhost works only via autoSelectFamily, 127.0.0.1 always', async (bind) => {
    const { server, port } = await listen(bind);
    try {
      // Both v4-only binds refuse IPv6 loopback — the PR's default changes nothing here.
      expect(await rawConnect('::1', port)).toBe('ECONNREFUSED');
      // Node ≥20 default (`autoSelectFamily` on): ::1 fails fast, 127.0.0.1 is tried next.
      expect(await dial({ host: 'localhost', port, lookup: v6First, autoSelectFamily: true })).toBe(200);
      // Without the fallback a `localhost` dial on a ::1-first host is dead — for either bind.
      expect(await dial({ host: 'localhost', port, lookup: v6First, autoSelectFamily: false })).toBe('ECONNREFUSED');
      // Dialing the loopback literal never consults the resolver.
      expect(await dial({ host: '127.0.0.1', port, lookup: v6First, autoSelectFamily: false })).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
