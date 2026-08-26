/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the ensureServer() OWNERSHIP decision.
 *
 * The decision logic is extracted into cli/utils/serverOwnership.ts (a pure,
 * import.meta-free module) so it can be imported under ts-jest — serverLifecycle.ts
 * itself uses ESM-only constructs the CommonJS test transform can't parse.
 *
 * A server already listening on the target port may be a FOREIGN instance
 * (a live demo, another checkout) that merely occupies the port. Reusing it
 * would route this run into the other instance's storage; a version mismatch
 * would kill it. decideServerOwnership() reads the /health instance.cwd to
 * decide refuse / reuse-foreign / proceed.
 */

import { decideServerOwnership, foreignServerError } from '@/cli/utils/serverOwnership';

const MY_CWD = '/home/me/agent-health-port-isolation';
const OTHER_CWD = '/home/me/agent-health-consolidated';

describe('decideServerOwnership()', () => {
  it('REFUSES a foreign server (different cwd) when override is off', () => {
    const d = decideServerOwnership({ serverCwd: OTHER_CWD, myCwd: MY_CWD, allowForeign: false });
    expect(d).toEqual({ action: 'refuse' });
  });

  it('REUSES a foreign server when AH_REUSE_FOREIGN_SERVER override is on', () => {
    const d = decideServerOwnership({ serverCwd: OTHER_CWD, myCwd: MY_CWD, allowForeign: true });
    expect(d).toEqual({ action: 'reuse-foreign' });
  });

  it('PROCEEDS for our own server (same cwd) — normal version/reuse logic applies', () => {
    const d = decideServerOwnership({ serverCwd: MY_CWD, myCwd: MY_CWD, allowForeign: false });
    expect(d).toEqual({ action: 'proceed' });
  });

  it('PROCEEDS when the server reports no instance identity (older build)', () => {
    const d = decideServerOwnership({ serverCwd: undefined, myCwd: MY_CWD, allowForeign: false });
    expect(d).toEqual({ action: 'proceed' });
  });

  it('PROCEEDS when the reported cwd is an empty string (treated as unknown)', () => {
    const d = decideServerOwnership({ serverCwd: '', myCwd: MY_CWD, allowForeign: false });
    expect(d).toEqual({ action: 'proceed' });
  });

  it('override does not change behaviour for our own server', () => {
    const d = decideServerOwnership({ serverCwd: MY_CWD, myCwd: MY_CWD, allowForeign: true });
    expect(d).toEqual({ action: 'proceed' });
  });
});

describe('foreignServerError()', () => {
  it('names both directories, the port, the pid, and the override escape hatch', () => {
    const msg = foreignServerError({ port: 4001, myCwd: MY_CWD, serverCwd: OTHER_CWD, serverPid: 4242 });
    expect(msg).toContain('port 4001');
    expect(msg).toContain(MY_CWD);
    expect(msg).toContain(OTHER_CWD);
    expect(msg).toContain('pid 4242');
    expect(msg).toContain('AH_REUSE_FOREIGN_SERVER=1');
  });

  it('omits the pid clause when no pid is known', () => {
    const msg = foreignServerError({ port: 4001, myCwd: MY_CWD, serverCwd: OTHER_CWD });
    expect(msg).not.toContain('pid ');
  });
});
