/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * coverage-diff-summary — a Markdown table of coverage for the source files a
 * PR touched, computed from one or more lcov reports. Library half: every
 * function here is imported by its unit test (so jest measures it); the thin
 * CLI entry is scripts/coverage-diff-summary.ts.
 *
 * CI appends the output to `$GITHUB_STEP_SUMMARY` so a reviewer can see, per
 * changed file, line %, branch % and the exact uncovered / partial line ranges
 * without leaving the Actions run (Codecov's PR comment shows per-file patch %,
 * not the missing line ranges).
 *
 * Line status follows Codecov's lcov semantics so the numbers here match the
 * `codecov/patch` status and the Codecov comment for the same lcov (see
 * codecov/worker services/report/languages/lcov.py): a line that carries
 * BRDA records is classified by its branches — all untaken = uncovered, some
 * untaken = partial, all taken = covered — regardless of its DA hit count,
 * and only fully covered lines count towards "Lines". Lines without branch
 * records are covered iff DA > 0. BRDA records on line 1 of a .ts file are
 * ignored (Codecov does the same; istanbul emits spurious ones there).
 *
 *   npx tsx scripts/coverage-diff-summary.ts --lcov coverage/lcov.info \
 *        --base <sha-or-ref> --title "Unit coverage — changed files"
 *
 *   npx tsx scripts/coverage-diff-summary.ts --lcov a.info --lcov b.info \
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
 * Exit code 0 with a table (or a one-line note when there is nothing to show);
 * 2 on a usage error. CI runs it with `continue-on-error` — visibility is the
 * point; gating is Codecov's job.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, sep } from 'node:path';

export interface FileCoverage {
  lines: Map<number, number>;
  branches: Map<string, boolean>;
}

export interface FileSummary {
  linesTotal: number;
  /** Fully covered lines (partials excluded, as Codecov counts them). */
  linesHit: number;
  uncovered: number[];
  /** Lines with branch records of which some, but not all, were taken. */
  partial: number[];
  branchesTotal: number;
  branchesHit: number;
}

export interface Options {
  lcov: string[];
  files: string[] | null;
  base: string | null;
  title: string;
  root: string;
}

/** Source files we report on. Tests, type-only files and non-code never make a row. */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const NOT_SOURCE = /(^|\/)(tests?|__tests__|__mocks__|e2e|dist|node_modules|coverage[^/]*)\//;
const NOT_SOURCE_FILE = /(\.test\.(ts|tsx|js)|\.spec\.(ts|tsx|js)|\.d\.ts|\.config\.(ts|js|cjs|mjs))$/;

export function isReportableSource(file: string): boolean {
  return SOURCE_EXT.test(file) && !NOT_SOURCE.test(file) && !NOT_SOURCE_FILE.test(file);
}

export function normalizePath(p: string, root: string): string {
  let out = p.trim();
  if (isAbsolute(out)) out = relative(root, out);
  return out.split(sep).join('/');
}

/**
 * Parse one or more lcov documents into Map<relativePath, FileCoverage>.
 * Paths are made relative to `root` (lcov from jest/c8 may be absolute).
 */
export function parseLcov(texts: string | string[], root: string = process.cwd()): Map<string, FileCoverage> {
  const files = new Map<string, FileCoverage>();
  for (const text of Array.isArray(texts) ? texts : [texts]) {
    let cur: FileCoverage | null = null;
    let curPath = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('SF:')) {
        const key = normalizePath(line.slice(3), root);
        curPath = key;
        cur = files.get(key) ?? null;
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
        // Codecov skips branch records on line 1 of .ts files (istanbul emits
        // spurious ones there); mirror it so the two never disagree on line 1.
        if (ln === '1' && curPath.endsWith('.ts')) continue;
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

/** Compact a list of line numbers into "1-3, 7, 10-12", capped at `maxRanges`. */
export function compactRanges(lines: number[], { maxRanges = 8 }: { maxRanges?: number } = {}): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  const shown = ranges.slice(0, maxRanges).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`));
  const rest = ranges.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, +${rest} more` : '');
}

/**
 * Classify every line the way Codecov's lcov parser does (see the file header):
 * branch-carrying lines by taken/total branches, the rest by DA hits.
 */
export function summarizeFile(cov: FileCoverage): FileSummary {
  const branchesByLine = new Map<number, { taken: number; total: number }>();
  for (const [key, hit] of cov.branches) {
    const ln = Number(key.split(':')[0]);
    const b = branchesByLine.get(ln) ?? { taken: 0, total: 0 };
    b.total += 1;
    if (hit) b.taken += 1;
    branchesByLine.set(ln, b);
  }
  // Codecov creates a line for every BRDA line even without a DA record.
  const lineNumbers = new Set<number>([...cov.lines.keys(), ...branchesByLine.keys()]);
  const uncovered: number[] = [];
  const partial: number[] = [];
  for (const ln of [...lineNumbers].sort((a, b) => a - b)) {
    const b = branchesByLine.get(ln);
    if (b) {
      if (b.taken === 0) uncovered.push(ln);
      else if (b.taken < b.total) partial.push(ln);
    } else if (cov.lines.get(ln) === 0) {
      uncovered.push(ln);
    }
  }
  const total = lineNumbers.size;
  const bTotal = cov.branches.size;
  const bHit = [...cov.branches.values()].filter(Boolean).length;
  return {
    linesTotal: total,
    linesHit: total - uncovered.length - partial.length,
    uncovered,
    partial,
    branchesTotal: bTotal,
    branchesHit: bHit,
  };
}

export function pct(hit: number, total: number): string {
  if (total === 0) return '—';
  return `${((hit / total) * 100).toFixed(1)}%`;
}

export function changedFilesFromGit(base: string, cwd: string = process.cwd()): string[] {
  const out = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', base, 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** Build the Markdown. Always returns a non-empty string. */
export function renderSummary({
  title,
  changed,
  coverage,
}: {
  title: string;
  changed: string[];
  coverage: Map<string, FileCoverage>;
}): string {
  const files = changed.filter(isReportableSource).sort();
  const head = title ? `### ${title}\n\n` : '';
  if (files.length === 0) {
    return `${head}_No changed source files in this suite's scope._\n`;
  }
  const rows: string[] = [];
  let tl = 0;
  let th = 0;
  let tb = 0;
  let tbh = 0;
  let measured = 0;
  for (const f of files) {
    const cov = coverage.get(f);
    const s = cov ? summarizeFile(cov) : null;
    if (!s || s.linesTotal === 0) {
      rows.push(`| \`${f}\` | n/a | n/a | _not measured by this suite_ | |`);
      continue;
    }
    measured += 1;
    tl += s.linesTotal;
    th += s.linesHit;
    tb += s.branchesTotal;
    tbh += s.branchesHit;
    const unc = s.uncovered.length === 0 ? '—' : compactRanges(s.uncovered);
    const part = s.partial.length === 0 ? '—' : compactRanges(s.partial);
    rows.push(`| \`${f}\` | ${pct(s.linesHit, s.linesTotal)} (${s.linesHit}/${s.linesTotal}) | ${pct(s.branchesHit, s.branchesTotal)} | ${unc} | ${part} |`);
  }
  const lines = [
    head.trimEnd(),
    '',
    '| File | Lines | Branches | Uncovered lines | Partial lines |',
    '|------|-------|----------|-----------------|---------------|',
    ...rows,
  ];
  if (measured > 0) {
    lines.push(`| **Total (${measured} measured)** | **${pct(th, tl)}** (${th}/${tl}) | **${pct(tbh, tb)}** | | |`);
    lines.push('');
    lines.push(
      '_Line status as Codecov counts it: a line whose branches were all untaken is uncovered, one with some untaken branches is partial; only fully covered lines count towards Lines %, so these numbers match `codecov/patch` for the same report._',
    );
  }
  lines.push('');
  return lines.join('\n').replace(/^\n/, '');
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { lcov: [], files: null, base: null, title: '', root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = (): string => {
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

/**
 * Whole program as a function: parse args, read the lcov files (an unreadable
 * file is reported on `warnings` and treated as empty), diff, render.
 * Throws on usage errors (the entry maps that to exit code 2).
 */
export function run(argv: string[]): { markdown: string; warnings: string[] } {
  const opts = parseArgs(argv);
  const warnings: string[] = [];
  const texts = opts.lcov.map((f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch (err) {
      warnings.push(`cannot read ${f}: ${(err as Error).message}`);
      return '';
    }
  });
  const coverage = parseLcov(texts, opts.root);
  const changed = opts.files ?? changedFilesFromGit(opts.base as string, opts.root);
  return { markdown: renderSummary({ title: opts.title, changed, coverage }), warnings };
}
