/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node.js runtime guard for the CLI entry point.
 *
 * `engines.node` in package.json only makes `npm install` / `npx` print an
 * EBADENGINE *warning* (engine-strict is off by default), so without this check
 * the CLI happily starts on an end-of-life Node 18/20 — exposed to
 * CVE-2026-111497 — and then fails in a confusing place (Node < 22.6 cannot
 * import an `agent-health.config.ts`, so the first error the user sees is
 * `Unknown file extension ".ts"`). This module turns the engines range into a
 * hard, explained refusal at startup.
 *
 * Plain CommonJS with zero dependencies on purpose: it must load and run on
 * ANY Node version — including the ones it is about to reject — before the
 * bundled CLI (which may use newer syntax or APIs) is touched. The range is
 * read from package.json so there is a single source of truth.
 */

'use strict';

const { readFileSync } = require('fs');

const SECURITY_NOTE =
  'releases below the required versions ship a brotli decoder with an out-of-bounds ' +
  'write that allows remote code execution (CVE-2026-111497); Node 18 and 20 are ' +
  'end-of-life and never received the fix.';

/**
 * Parse "X.Y.Z" (optionally prefixed with "v", optionally with a pre-release /
 * build suffix) into a numeric triple. Returns null when unparseable.
 * @param {string} version
 * @returns {[number, number, number] | null}
 */
function parseVersion(version) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Evaluate ONE comparator (`^1.2.3`, `~1.2.3`, `>=1.2.3`, `>1.2.3`, `<=1.2.3`,
 * `<1.2.3`, `=1.2.3` or a bare `1.2.3`) against a parsed version.
 * Throws on syntax this guard does not understand, so a typo in package.json
 * surfaces in the unit test instead of silently allowing or refusing everyone.
 * @param {[number, number, number]} version
 * @param {string} comparator
 * @returns {boolean}
 */
function satisfiesComparator(version, comparator) {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(v?\d+(?:\.\d+){0,2}(?:[-+][\w.-]+)?)$/.exec(comparator.trim());
  if (!match) {
    throw new Error(`Unsupported version comparator "${comparator}"`);
  }
  const operator = match[1] || '=';
  const bound = parseVersion(match[2]);
  if (!bound) {
    throw new Error(`Unsupported version comparator "${comparator}"`);
  }
  const cmp = compareVersions(version, bound);

  switch (operator) {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '^':
      // Same major (for major 0 npm narrows further; Node has no 0.x in scope).
      return cmp >= 0 && version[0] === bound[0];
    case '~':
      return cmp >= 0 && version[0] === bound[0] && version[1] === bound[1];
    default:
      throw new Error(`Unsupported version comparator "${comparator}"`);
  }
}

/**
 * Does `version` satisfy an npm-style `engines` range? Supports the subset
 * npm's semver uses for engine ranges: comparators joined by whitespace (AND)
 * and `||` (OR).
 * @param {string} version e.g. "22.23.4"
 * @param {string} range e.g. "^22.23.4 || ^24.22.1 || >=26.12.1"
 * @returns {boolean}
 */
function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Unparseable Node.js version "${version}"`);
  }
  const alternatives = String(range)
    .split('||')
    .map((alt) => alt.trim())
    .filter(Boolean);
  if (alternatives.length === 0) {
    throw new Error(`Empty engines range "${range}"`);
  }
  return alternatives.some((alt) => alt.split(/\s+/).every((cmp) => satisfiesComparator(parsed, cmp)));
}

/**
 * Read `engines.node` from a package.json file.
 * @param {string} packageJsonPath
 * @returns {string}
 */
function readEnginesRange(packageJsonPath) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const range = pkg && pkg.engines && pkg.engines.node;
  if (typeof range !== 'string' || range.trim() === '') {
    throw new Error(`${packageJsonPath} has no engines.node range`);
  }
  return range;
}

/**
 * Human-readable rendering of the range: "22.23.4+ (22.x), 24.22.1+ (24.x) or 26.12.1+".
 * Falls back to the raw range for comparators this does not know how to phrase.
 * @param {string} range
 * @returns {string}
 */
function describeRange(range) {
  const parts = String(range)
    .split('||')
    .map((alt) => alt.trim())
    .filter(Boolean)
    .map((alt) => {
      const match = /^(\^|>=)\s*v?(\d+)\.(\d+)\.(\d+)$/.exec(alt);
      if (!match) return alt;
      const [, op, major, minor, patch] = match;
      const floor = `${major}.${minor}.${patch}+`;
      return op === '^' ? `${floor} (${major}.x)` : floor;
    });
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/**
 * Build the refusal message printed to stderr.
 * @param {string} currentVersion e.g. "20.19.0"
 * @param {string} range the engines.node range
 * @returns {string}
 */
function formatUnsupportedNodeMessage(currentVersion, range) {
  return [
    `agent-health: unsupported Node.js version v${currentVersion}.`,
    '',
    `  Required: Node.js ${describeRange(range)}  (package.json engines.node: "${range}")`,
    '',
    '  Why:',
    `    - Security: ${SECURITY_NOTE}`,
    '      https://nvd.nist.gov/vuln/detail/CVE-2026-111497',
    '    - TypeScript config: `agent-health.config.ts` is loaded with Node\'s built-in',
    '      type stripping, which older releases do not have (the failure there is a',
    '      confusing `Unknown file extension ".ts"`).',
    '',
    '  How to upgrade:',
    '    nvm install 24 && nvm use 24      # or: mise use node@24 / fnm use 24',
    '    or download a current release from https://nodejs.org/',
    '',
  ].join('\n');
}

/**
 * Check a Node.js version against an engines range.
 * @param {string} currentVersion e.g. process.versions.node
 * @param {string} range the engines.node range
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function checkNodeVersion(currentVersion, range) {
  if (satisfiesRange(currentVersion, range)) {
    return { ok: true };
  }
  return { ok: false, message: formatUnsupportedNodeMessage(currentVersion, range) };
}

module.exports = {
  parseVersion,
  satisfiesRange,
  readEnginesRange,
  describeRange,
  formatUnsupportedNodeMessage,
  checkNodeVersion,
};
