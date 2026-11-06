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
 * CVE-2026-111497 — and then fails in a confusing place (older Node cannot
 * import an `agent-health.config.ts`, so the first error the user sees is
 * `Unknown file extension ".ts"`). This module turns the engines range into a
 * hard, explained refusal at startup.
 *
 * Plain CommonJS on purpose: it must load and run on ANY Node version —
 * including the ones it is about to reject — before the bundled CLI (which may
 * use newer syntax or APIs) is touched. The range is read from package.json
 * (single source of truth) and evaluated with `semver`, the same library npm
 * uses for `engines`, with default options: a pre-release of the floor
 * (`22.23.4-rc.0`) is therefore refused, as it should be.
 */

'use strict';

const { readFileSync, writeSync } = require('fs');

const ISSUES_URL = 'https://github.com/opensearch-project/agent-health/issues';

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
 * Human-readable rendering of a semver range from its parsed comparator sets:
 * "^22.23.4 || ^24.22.1 || >=26.12.1" → "22.23.4+ (22.x), 24.22.1+ (24.x) or 26.12.1+".
 * @param {string} range
 * @returns {string}
 */
function describeRange(range) {
  const semver = require('semver');
  const parts = new semver.Range(range).set.map((comparators) => {
    const lower = comparators.find((c) => c.operator === '>=' || c.operator === '');
    const upper = comparators.find((c) => c.operator === '<' || c.operator === '<=');
    const floor = lower && `${lower.semver.version}+`;
    if (lower && !upper) return floor;
    const caretShaped =
      lower && upper && upper.operator === '<' && upper.semver.major === lower.semver.major + 1 &&
      upper.semver.minor === 0 && upper.semver.patch === 0;
    if (caretShaped) return `${floor} (${lower.semver.major}.x)`;
    return comparators.map(String).join(' '); // shapes we don't phrase: show the comparators as-is
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
 * Check a Node.js version against an engines range (semver defaults).
 * Throws if the range is not valid semver syntax.
 * @param {string} currentVersion e.g. process.versions.node
 * @param {string} range the engines.node range
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
function checkNodeVersion(currentVersion, range) {
  const semver = require('semver');
  if (semver.validRange(range) === null) {
    throw new Error(`Invalid engines.node range "${range}"`);
  }
  if (semver.satisfies(currentVersion, range)) {
    return { ok: true };
  }
  return { ok: false, message: formatUnsupportedNodeMessage(currentVersion, range) };
}

/**
 * Entry-point glue: check the running Node against `engines.node` of the
 * given package.json and, if it is unsupported — or the requirement cannot be
 * verified at all (fail CLOSED, with a controlled message rather than a stack
 * trace) — write the message synchronously to stderr and exit 1.
 * `writeSync(2)` + `process.exit` is used on purpose: `process.stderr.write`
 * on a pipe is asynchronous and can be truncated by `process.exit`, while
 * leaving the process to end naturally can hang if a preload left handles
 * open. Returns normally only when the runtime is fine.
 * @param {string} packageJsonPath
 */
function enforceSupportedNode(packageJsonPath) {
  let verdict;
  try {
    verdict = checkNodeVersion(process.versions.node, readEnginesRange(packageJsonPath));
  } catch (error) {
    // Say what is actually wrong: a missing/unreadable package.json or semver
    // is a broken install; a malformed engines.node is a defect in this package.
    const reason = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const hint =
      code === 'ENOENT' || code === 'EACCES' || code === 'EISDIR' || code === 'MODULE_NOT_FOUND' || error instanceof SyntaxError
        ? '  The package install looks incomplete (package.json or the semver dependency is missing or unreadable); reinstall it.\n'
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
  readEnginesRange,
  describeRange,
  formatUnsupportedNodeMessage,
  checkNodeVersion,
  enforceSupportedNode,
};
