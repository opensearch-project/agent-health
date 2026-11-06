/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for bin/nodeVersionGuard.cjs — the runtime Node.js version check
 * the CLI shim (bin/cli.js) runs before loading anything else. The range under
 * test is the REAL `engines.node` from package.json (single source of truth)
 * evaluated by the real `semver`; these pin the floors and the message, not a
 * comparator implementation. The refusal/exit path itself is covered by the
 * real-process integration spec (tests/integration/cli/nodeVersionGuard.*).
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../bin/nodeVersionGuard.cjs') as {
  readEnginesRange: (packageJsonPath: string) => string;
  describeRange: (range: string) => string;
  formatUnsupportedNodeMessage: (version: string, range: string) => string;
  checkNodeVersion: (version: string, range: string) => { ok: true } | { ok: false; message: string };
};

const ROOT = join(__dirname, '..', '..', '..');
const PACKAGE_JSON = join(ROOT, 'package.json');

describe('bin/nodeVersionGuard.cjs', () => {
  const range = guard.readEnginesRange(PACKAGE_JSON);

  it('reads engines.node from the real package.json and it is valid semver', () => {
    expect(range).toBe(JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')).engines.node);
    expect(() => guard.checkNodeVersion('24.22.1', range)).not.toThrow();
  });

  it('throws when the file has no engines.node (the shim then fails closed)', () => {
    const tmp = join(tmpdir(), `ah-node-guard-${process.pid}-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ name: 'x', engines: {} }));
    try {
      expect(() => guard.readEnginesRange(tmp)).toThrow(/engines\.node/);
    } finally {
      unlinkSync(tmp);
    }
  });

  it('throws on a range semver cannot parse instead of silently allowing or refusing everyone', () => {
    expect(() => guard.checkNodeVersion('24.22.1', '^22.23.4 || garbage')).toThrow(/Invalid engines.node range/);
  });

  // Pins the security floors in package.json (CVE-2026-111497 fixed in 22.23.4 /
  // 24.22.1 / 26.12.1). semver defaults: a pre-release of the floor is refused.
  it.each(['18.20.8', '20.19.0', '22.18.0', '22.23.3', '22.23.4-rc.0', '24.22.0', '26.12.0'])('refuses %s', (version) => {
    expect(guard.checkNodeVersion(version, range).ok).toBe(false);
  });

  it.each(['22.23.4', '22.99.0', '24.22.1', '26.12.1', '27.0.0', 'v24.22.1'])('allows %s', (version) => {
    expect(guard.checkNodeVersion(version, range)).toEqual({ ok: true });
  });

  it('allows the Node version this test suite is running on', () => {
    expect(guard.checkNodeVersion(process.versions.node, range)).toEqual({ ok: true });
  });

  describe('refusal message', () => {
    it('describes the range in human terms, derived from semver\'s parse', () => {
      expect(guard.describeRange('^22.23.4 || ^24.22.1 || >=26.12.1')).toBe('22.23.4+ (22.x), 24.22.1+ (24.x) or 26.12.1+');
      expect(guard.describeRange('>=26.12.1')).toBe('26.12.1+');
      // Shapes it does not phrase show semver's comparators as-is instead of lying.
      expect(guard.describeRange('22.23.4 - 24.0.0')).toBe('>=22.23.4 <=24.0.0');
    });

    it('names the current version, the requirement, the reasons and how to upgrade', () => {
      const verdict = guard.checkNodeVersion('20.19.0', range);
      expect(verdict.ok).toBe(false);
      const message = (verdict as { ok: false; message: string }).message;
      expect(message).toContain('unsupported Node.js version v20.19.0');
      expect(message).toContain(`engines.node: "${range}"`);
      expect(message).toContain(guard.describeRange(range));
      expect(message).toContain('CVE-2026-111497');
      expect(message).toContain('agent-health.config.ts');
      expect(message).toContain('Unknown file extension ".ts"');
      expect(message).toContain('nvm install 24');
      expect(message).toContain('https://nodejs.org/');
      expect(message.endsWith('\n')).toBe(true);
      expect(guard.formatUnsupportedNodeMessage('20.19.0', range)).toBe(message);
      expect(guard.formatUnsupportedNodeMessage('v20.19.0', range)).not.toContain('vv20');
    });
  });
});
