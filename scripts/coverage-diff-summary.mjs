#!/usr/bin/env node
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * coverage-diff-summary — a Markdown table of coverage for the source files a
 * PR touched, computed from one or more lcov reports.
 *
 * CI appends the output to `$GITHUB_STEP_SUMMARY` so a reviewer can see, per
 * changed file, line %, branch % and the exact uncovered line ranges without
 * leaving the Actions run (Codecov's PR comment shows per-file patch %, not the
 * missing line ranges).
 *
 *   node scripts/coverage-diff-summary.mjs --lcov coverage/lcov.info \
 *        --base <sha-or-ref> --title "Unit coverage — changed files"
 *
 *   node scripts/coverage-diff-summary.mjs --lcov a.info --lcov b.info \
 *        --files cli/commands/run.ts,lib/config.ts
 *
 * Options
 *   --lcov <file>      lcov report; repeat to merge several (hits are summed,
 *                      branch "taken" is OR'd).
 *   --base <ref>       changed files = `git diff --name-only --diff-filter=ACMR <ref> HEAD`
 *   --files <a,b,...>  explicit changed-file list (skips git; used by tests).
 *   --title <text>     heading above the table.
 *   --root <dir>       repo root used to relativise absolute SF: paths (default: cwd).
 *
 * The tool never fails the build: it exits 0 and prints a note when there is
 * nothing to show. Visibility is the point; gating is Codecov's job.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';

/** Source files we report on. Tests, type-only files and non-code never make a row. */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NOT_SOURCE = /(^|\/)(tests?|__tests__|__mocks__|e2e|dist|node_modules|coverage[^/]*)\//;
const NOT_SOURCE_FILE = /(\.test\.(ts|tsx|js)|\.spec\.(ts|tsx|js)|\.d\.ts|\.config\.(ts|js|cjs|mjs))$/;

export function isReportableSource(file) {
  return SOURCE_EXT.test(file) && !NOT_SOURCE.test(file) && !NOT_SOURCE_FILE.test(file);
}

/**
 * Parse one or more lcov documents into
 *   Map<relativePath, { lines: Map<lineNo, hits>, branches: Map<key, taken> }>
 * Paths are made relative to `root` (lcov from jest/c8 may be absolute).
 */
export function parseLcov(texts, root = process.cwd()) {
  const files = new Map();
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('SF:')) {
        const key = normalizePath(line.slice(3), root);
        cur = files.get(key);
        if (!cur) {
          cur = { lines: new Map(), branches: new Map() };
          files.set(key, cur);
        }
      } else if (!cur) {
        continue;
      } else if (line.startsWith('DA:')) {
        const [ln, hits] = line.slice(3).split(',');
        const n = Number(ln);
        cur.lines.set(n, (cur.lines.get(n) ?? 0) + Number(hits));
      } else if (line.startsWith('BRDA:')) {
        // BRDA:<line>,<block>,<branch>,<taken|->
        const [ln, block, br, taken] = line.slice(5).split(',');
        const key = `${ln}:${block}:${br}`;
        const hit = taken !== '-' && Number(taken) > 0;
        cur.branches.set(key, (cur.branches.get(key) ?? false) || hit);
      } else if (line === 'end_of_record') {
        cur = null;
      }
    }
  }
  return files;
}

export function normalizePath(p, root) {
  let out = p.trim();
  if (isAbsolute(out)) out = relative(root, out);
  return out.split(sep).join('/');
}

/** Compact a sorted list of line numbers into "1-3, 7, 10-12". */
export function compactRanges(lines, { maxRanges = 8 } = {}) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const shown = ranges.slice(0, maxRanges).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  const rest = ranges.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, +${rest} more` : '');
}

export function summarizeFile(cov) {
  const total = cov.lines.size;
  const uncovered = [...cov.lines.entries()].filter(([, h]) => h === 0).map(([n]) => n);
  const bTotal = cov.branches.size;
  const bHit = [...cov.branches.values()].filter(Boolean).length;
  return {
    linesTotal: total,
    linesHit: total - uncovered.length,
    uncovered,
    branchesTotal: bTotal,
    branchesHit: bHit,
  };
}

export function pct(hit, total) {
  if (total === 0) return '—';
  return `${((hit / total) * 100).toFixed(1)}%`;
}

export function changedFilesFromGit(base, cwd = process.cwd()) {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the Markdown. `changed` is the raw changed-file list; `coverage` is
 * the parsed lcov map. Returns a string (always non-empty).
 */
export function renderSummary({ title, changed, coverage }) {
  const files = changed.filter(isReportableSource).sort();
  const head = title ? `### ${title}\n\n` : '';
  if (files.length === 0) {
    return `${head}_No changed source files in this suite's scope._\n`;
  }
  const rows = [];
  let tl = 0;
  let th = 0;
  let tb = 0;
  let tbh = 0;
  let measured = 0;
  for (const f of files) {
    const cov = coverage.get(f);
    if (!cov || cov.lines.size === 0) {
      rows.push(`| \`${f}\` | n/a | n/a | _not measured by this suite_ |`);
      continue;
    }
    measured += 1;
    const s = summarizeFile(cov);
    tl += s.linesTotal;
    th += s.linesHit;
    tb += s.branchesTotal;
    tbh += s.branchesHit;
    const unc = s.uncovered.length === 0 ? '—' : compactRanges(s.uncovered);
    rows.push(`| \`${f}\` | ${pct(s.linesHit, s.linesTotal)} (${s.linesHit}/${s.linesTotal}) | ${pct(s.branchesHit, s.branchesTotal)} | ${unc} |`);
  }
  const lines = [
    head.trimEnd(),
    '',
    '| File | Lines | Branches | Uncovered lines |',
    '|------|-------|----------|-----------------|',
    ...rows,
  ];
  if (measured > 0) {
    lines.push(`| **Total (${measured} measured)** | **${pct(th, tl)}** (${th}/${tl}) | **${pct(tbh, tb)}** | |`);
  }
  lines.push('');
  return lines.join('\n').replace(/^\n/, '');
}

export function parseArgs(argv) {
  const opts = { lcov: [], files: null, base: null, title: '', root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[i];
    };
    if (a === '--lcov') opts.lcov.push(next());
    else if (a === '--files') opts.files = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--base') opts.base = next();
    else if (a === '--title') opts.title = next();
    else if (a === '--root') opts.root = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.lcov.length === 0) throw new Error('--lcov <file> is required');
  if (!opts.files && !opts.base) throw new Error('one of --base <ref> or --files <a,b> is required');
  return opts;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const texts = opts.lcov.map((f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch (err) {
      process.stderr.write(`coverage-diff-summary: cannot read ${f}: ${err.message}\n`);
      return '';
    }
  });
  const coverage = parseLcov(texts, opts.root);
  const changed = opts.files ?? changedFilesFromGit(opts.base, opts.root);
  process.stdout.write(renderSummary({ title: opts.title, changed, coverage }));
  return 0;
}

if (process.argv[1] && /coverage-diff-summary\.mjs$/.test(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`coverage-diff-summary: ${err.message}\n`);
    process.exitCode = 2;
  }
}
