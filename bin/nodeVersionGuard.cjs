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

const { readFileSync, writeSync } = require('fs');

const ISSUES_URL = 'https://github.com/opensearch-project/agent-health/issues';

/**
 * Parse "X.Y.Z" (optional leading "v", optional pre-release `-tag` and build
 * `+meta`) into a comparable tuple `[major, minor, patch, release]` where
 * `release` is 1 for a final release and 0 for a pre-release — semver orders a
 * pre-release BELOW its final version (`22.23.4-rc.0 < 22.23.4`), so a
 * release-candidate of the floor must not pass a `>=` floor. Build metadata
 * does not affect precedence. Returns null when unparseable; partial versions
 * ("24", "24.1") are NOT accepted — engine floors here are always full.
 * @param {string} version
 * @returns {[number, number, number, number] | null}
 */
function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(String(version).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ? 0 : 1];
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Parse ONE comparator. Grammar is deliberately tiny — exactly what an engine
 * floor needs: `^X.Y.Z`, `>=X.Y.Z`, `>X.Y.Z`, `<=X.Y.Z`, `<X.Y.Z`, all with
 * full release versions. Anything else throws.
 * @param {string} comparator
 * @returns {{ operator: string, bound: number[] }}
 */
function parseComparator(comparator) {
  const match = /^(\^|>=|<=|>|<)\s*(v?\d+\.\d+\.\d+)$/.exec(comparator.trim());
  const bound = match ? parseVersion(match[2]) : null;
  if (!match || !bound) {
    throw new Error(
      `Unsupported version comparator "${comparator}" (expected ^X.Y.Z, >=X.Y.Z, >X.Y.Z, <=X.Y.Z or <X.Y.Z)`
    );
  }
  return { operator: match[1], bound };
}

/**
 * Parse a whole range EAGERLY — every alternative and every comparator is
 * validated before anything is evaluated, so `^22.23.4 || garbage` or a
 * trailing `||` throws instead of being short-circuited past on a matching
 * runtime. The unit test runs the REAL package.json range through this, so an
 * unsupported edit to `engines.node` fails CI, never the user's CLI.
 * @param {string} range e.g. "^22.23.4 || ^24.22.1 || >=26.12.1"
 * @returns {Array<Array<{ operator: string, bound: number[] }>>} OR of ANDs
 */
function parseRange(range) {
  const text = String(range).trim();
  if (text === '') throw new Error('Empty engines range');
  return text.split('||').map((alternative) => {
    const alt = alternative.trim();
    if (alt === '') throw new Error(`Empty alternative in engines range "${range}"`);
    return alt.split(/\s+/).map(parseComparator);
  });
}

/**
 * @param {number[]} version parsed tuple
 * @param {{ operator: string, bound: number[] }} comparator
 * @returns {boolean}
 */
function satisfiesComparator(version, { operator, bound }) {
  const cmp = compareVersions(version, bound);
  switch (operator) {
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '^':
      // Same major, at or above the floor (Node has no 0.x line in scope).
      return cmp >= 0 && version[0] === bound[0];
    default:
      throw new Error(`Unsupported version comparator "${operator}"`);
  }
}

/**
 * Does `version` satisfy an npm-style `engines` range? A deliberate SUBSET of
 * node-semver: `||`-separated alternatives of whitespace-ANDed comparators
 * (see parseComparator). Pre-releases order below their final release as in
 * semver (`22.23.4-rc.0` fails `^22.23.4`; `27.0.0-nightly…` passes
 * `>=26.12.1`); build metadata is ignored. Throws on an unparseable version or
 * any unsupported range syntax.
 * @param {string} version e.g. "22.23.4"
 * @param {string} range e.g. "^22.23.4 || ^24.22.1 || >=26.12.1"
 * @returns {boolean}
 */
function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) {
    throw new Error(`Unparseable Node.js version "${version}"`);
  }
  const alternatives = parseRange(range);
  return alternatives.some((comparators) => comparators.every((cmp) => satisfiesComparator(parsed, cmp)));
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
  const current = String(currentVersion).replace(/^v/, '');
  return [
    `agent-health: unsupported Node.js version v${current}.`,
    '',
    `  Required: Node.js ${describeRange(range)}  (package.json engines.node: "${range}")`,
    '',
    '  Why:',
    '    - Security: CVE-2026-111497 (brotli decoder out-of-bounds write, remote code',
    '      execution) is fixed only from the releases above; Node 18 and 20 are',
    '      end-of-life and never received the fix. Other lines (e.g. odd-numbered',
    '      non-LTS releases) are outside what agent-health is tested on.',
    '      https://nvd.nist.gov/vuln/detail/CVE-2026-111497',
    "    - TypeScript config: `agent-health.config.ts` is loaded with Node's built-in",
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

/**
 * Entry-point glue: check the running Node against `engines.node` of the
 * given package.json and, if it is unsupported — or the requirement cannot be
 * read at all (corrupt / incomplete install; fail CLOSED, with a controlled
 * message rather than a stack trace) — write the message synchronously to
 * stderr and exit 1. `writeSync(2)` + `process.exit` is used on purpose:
 * `process.stderr.write` on a pipe is asynchronous and can be truncated by
 * `process.exit`, while leaving the process to end naturally can hang if a
 * preload left handles open. Returns normally only when the runtime is fine.
 * @param {string} packageJsonPath
 */
function enforceSupportedNode(packageJsonPath) {
  let verdict;
  try {
    verdict = checkNodeVersion(process.versions.node, readEnginesRange(packageJsonPath));
  } catch (error) {
    // Fail CLOSED, but say what is actually wrong: a missing/unreadable
    // package.json is a broken install; a malformed engines.node or an
    // unparseable runtime version is a bug in this package, not the user's Node.
    const reason = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const hint =
      code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR' || error instanceof SyntaxError
        ? `  ${packageJsonPath} is missing or unreadable — the package install looks incomplete; reinstall it.\n`
        : `  This is a defect in the agent-health package, not in your Node.js — please report it at ${ISSUES_URL}\n`;
    verdict = {
      ok: false,
      message: `agent-health: could not verify the Node.js version requirement (${reason}).\n${hint}`,
    };
  }
  if (verdict.ok) return;
  writeSync(2, verdict.message);
  process.exit(1);
}

module.exports = {
  parseVersion,
  parseRange,
  enforceSupportedNode,
  satisfiesRange,
  readEnginesRange,
  describeRange,
  formatUnsupportedNodeMessage,
  checkNodeVersion,
};
