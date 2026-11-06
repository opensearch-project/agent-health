/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for bin/nodeVersionGuard.cjs — the runtime Node.js version check
 * the CLI shim (bin/cli.js) runs before loading anything else.
 *
 * The guard is plain CommonJS (it must execute on the Node versions it rejects),
 * so it is loaded with `require` here. The range under test is the REAL
 * `engines.node` from package.json — the single source of truth — so a change
 * to the floor there is reflected (and asserted) here.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('../../../bin/nodeVersionGuard.cjs') as {
  parseVersion: (v: string) => [number, number, number, number] | null;
  parseRange: (range: string) => Array<Array<{ operator: string; bound: number[] }>>;
  satisfiesRange: (version: string, range: string) => boolean;
  readEnginesRange: (packageJsonPath: string) => string;
  describeRange: (range: string) => string;
  formatUnsupportedNodeMessage: (version: string, range: string) => string;
  checkNodeVersion: (version: string, range: string) => { ok: true } | { ok: false; message: string };
};

const ROOT = join(__dirname, '..', '..', '..');
const PACKAGE_JSON = join(ROOT, 'package.json');

describe('bin/nodeVersionGuard.cjs', () => {
  describe('readEnginesRange', () => {
    it('reads engines.node from the real package.json (single source of truth)', () => {
      const expected = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')).engines.node;
      expect(typeof expected).toBe('string');
      expect(guard.readEnginesRange(PACKAGE_JSON)).toBe(expected);
    });

    it('throws when the file has no engines.node', () => {
      const tmp = join(tmpdir(), `ah-node-guard-${process.pid}-${Date.now()}.json`);
      writeFileSync(tmp, JSON.stringify({ name: 'x', engines: {} }));
      try {
        expect(() => guard.readEnginesRange(tmp)).toThrow(/engines\.node/);
      } finally {
        unlinkSync(tmp);
      }
    });
  });

  describe('against the real engines range', () => {
    const range = guard.readEnginesRange(PACKAGE_JSON);

    it.each(['18.20.8', '20.19.0', '20.20.2', '22.18.0', '22.23.3', '24.0.0', '24.22.0', '26.0.0', '26.12.0'])(
      'refuses %s',
      (version) => {
        expect(guard.satisfiesRange(version, range)).toBe(false);
        const verdict = guard.checkNodeVersion(version, range);
        expect(verdict.ok).toBe(false);
      }
    );

    it.each(['22.23.4', '22.99.0', '24.22.1', '24.30.5', '26.12.1', '26.13.0', '27.0.0', '30.1.2'])(
      'allows %s',
      (version) => {
        expect(guard.satisfiesRange(version, range)).toBe(true);
        expect(guard.checkNodeVersion(version, range)).toEqual({ ok: true });
      }
    );

    it('allows the Node version this test suite is running on', () => {
      // If this fails, the repo's own CI/dev Node is outside engines.node.
      expect(guard.checkNodeVersion(process.versions.node, range)).toEqual({ ok: true });
    });

    it('accepts a leading "v"; build metadata is ignored', () => {
      expect(guard.satisfiesRange('v24.22.1', range)).toBe(true);
      expect(guard.satisfiesRange('24.22.1+vendor.3', range)).toBe(true);
      expect(guard.satisfiesRange('v20.19.0', range)).toBe(false);
    });

    it('orders pre-releases BELOW their final release, like semver', () => {
      // A release candidate of the security floor is not the fixed release.
      expect(guard.satisfiesRange('22.23.4-rc.0', range)).toBe(false);
      expect(guard.satisfiesRange('24.22.1-rc.1', range)).toBe(false);
      expect(guard.satisfiesRange('26.12.1-rc.1', range)).toBe(false);
      // A pre-release of a LATER version is above the floor.
      expect(guard.satisfiesRange('22.23.5-rc.0', range)).toBe(true);
      expect(guard.satisfiesRange('27.0.0-nightly20261101abcdef', range)).toBe(true);
    });
  });

  describe('satisfiesRange comparator semantics', () => {
    it('caret: same major, at or above the floor', () => {
      expect(guard.satisfiesRange('22.23.4', '^22.23.4')).toBe(true);
      expect(guard.satisfiesRange('22.24.0', '^22.23.4')).toBe(true);
      expect(guard.satisfiesRange('22.23.3', '^22.23.4')).toBe(false);
      expect(guard.satisfiesRange('23.0.0', '^22.23.4')).toBe(false);
    });

    it('>=, >, <=, <', () => {
      expect(guard.satisfiesRange('26.12.1', '>=26.12.1')).toBe(true);
      expect(guard.satisfiesRange('26.12.0', '>=26.12.1')).toBe(false);
      expect(guard.satisfiesRange('26.12.1', '>26.12.1')).toBe(false);
      expect(guard.satisfiesRange('26.12.2', '>26.12.1')).toBe(true);
      expect(guard.satisfiesRange('26.12.1', '<=26.12.1')).toBe(true);
      expect(guard.satisfiesRange('26.12.2', '<=26.12.1')).toBe(false);
      expect(guard.satisfiesRange('26.12.1', '<26.12.1')).toBe(false);
      expect(guard.satisfiesRange('26.12.0', '<26.12.1')).toBe(true);
    });

    it('whitespace-joined comparators are ANDed, || alternatives are ORed', () => {
      expect(guard.satisfiesRange('22.5.0', '>=22.0.0 <23.0.0')).toBe(true);
      expect(guard.satisfiesRange('23.0.0', '>=22.0.0 <23.0.0')).toBe(false);
      expect(guard.satisfiesRange('23.0.0', '>=22.0.0 <23.0.0 || ^24.0.0')).toBe(false);
      expect(guard.satisfiesRange('24.1.0', '>=22.0.0 <23.0.0 || ^24.0.0')).toBe(true);
    });

    it('validates the WHOLE range before evaluating — a matching first alternative cannot hide garbage', () => {
      expect(() => guard.satisfiesRange('22.23.4', '^22.23.4 || garbage')).toThrow(/Unsupported version comparator "garbage"/);
      expect(() => guard.satisfiesRange('22.23.4', '^22.23.4 ||')).toThrow(/Empty alternative/);
      expect(() => guard.satisfiesRange('22.23.4', '|| ^22.23.4')).toThrow(/Empty alternative/);
      expect(() => guard.parseRange('^22.23.4 || ^24.22.1 || >=26.12.1')).not.toThrow();
      expect(guard.parseRange('^22.23.4 || >=26.12.1')).toEqual([
        [{ operator: '^', bound: [22, 23, 4, 1] }],
        [{ operator: '>=', bound: [26, 12, 1, 1] }],
      ]);
    });

    it('rejects syntax outside the tiny supported grammar rather than guessing', () => {
      for (const bad of ['22.x', '*', '>=22.0.0 - 24.0.0', '^22', '^22.23', '~22.23.4', '=22.23.4', '22.23.4', '^22.23.4-rc.0']) {
        expect(() => guard.satisfiesRange('24.0.0', bad)).toThrow(/Unsupported version comparator/);
      }
      expect(() => guard.satisfiesRange('24.0.0', '')).toThrow(/Empty engines range/);
      expect(() => guard.satisfiesRange('24.0.0', '   ')).toThrow(/Empty engines range/);
      expect(() => guard.satisfiesRange('not-a-version', '>=22.0.0')).toThrow(/Unparseable Node.js version/);
      expect(() => guard.satisfiesRange('24', '>=22.0.0')).toThrow(/Unparseable Node.js version/);
    });

    it('parseVersion: full versions only; release flag orders pre-releases below finals', () => {
      expect(guard.parseVersion('24.1.2')).toEqual([24, 1, 2, 1]);
      expect(guard.parseVersion('v24.1.2')).toEqual([24, 1, 2, 1]);
      expect(guard.parseVersion('24.1.2-rc.1')).toEqual([24, 1, 2, 0]);
      expect(guard.parseVersion('24.1.2+build.7')).toEqual([24, 1, 2, 1]);
      expect(guard.parseVersion('24.1.2-rc.1+build')).toEqual([24, 1, 2, 0]);
      expect(guard.parseVersion('24')).toBeNull();
      expect(guard.parseVersion('v24.1')).toBeNull();
      expect(guard.parseVersion('latest')).toBeNull();
    });
  });

  describe('refusal message', () => {
    const range = guard.readEnginesRange(PACKAGE_JSON);

    it('describes the real range in human terms', () => {
      // Derived from package.json so the assertion tracks the single source of truth.
      expect(guard.describeRange('^22.23.4 || ^24.22.1 || >=26.12.1')).toBe(
        '22.23.4+ (22.x), 24.22.1+ (24.x) or 26.12.1+'
      );
      expect(guard.describeRange('>=26.12.1')).toBe('26.12.1+');
      // Comparator shapes it cannot phrase fall back to the raw text instead of lying.
      expect(guard.describeRange('<22.23.4 || >=24.0.0')).toBe('<22.23.4 or 24.0.0+');
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
      // Does not blanket-label every rejected line as vulnerable.
      expect(message).toContain('fixed only from the releases above');
    });

    it('does not double the "v" when given a v-prefixed version', () => {
      expect(guard.formatUnsupportedNodeMessage('v20.19.0', range)).toContain('version v20.19.0.');
      expect(guard.formatUnsupportedNodeMessage('v20.19.0', range)).not.toContain('vv20');
    });
  });
});
