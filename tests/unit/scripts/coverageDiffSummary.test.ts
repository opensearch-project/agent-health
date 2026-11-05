/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * scripts/coverageDiffSummary.ts is imported DIRECTLY here so jest measures it
 * (it is in `collectCoverageFrom`) — the lcov parser, the range compaction,
 * the git diff and the table rendering run in-process against hand-written
 * lcov fixtures and a throwaway git repo. One test also executes the real CLI
 * entry (scripts/coverage-diff-summary.ts via tsx) the way CI invokes it, to
 * pin stdout/exit-code behaviour.
 */

import { execFile, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  changedFilesFromGit,
  compactRanges,
  isReportableSource,
  normalizePath,
  parseArgs,
  parseLcov,
  pct,
  renderSummary,
  run,
  summarizeFile,
} from '../../../scripts/coverageDiffSummary';

const ENTRY = join(__dirname, '..', '..', '..', 'scripts', 'coverage-diff-summary.ts');
const TSX = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx');

function runEntry(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(TSX, [ENTRY, ...args], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as unknown as { code?: unknown }).code === 'number'
        ? (err as unknown as { code: number }).code
        : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const LCOV_A = [
  'TN:',
  'SF:lib/alpha.ts',
  'FN:3,go',
  'FNF:1',
  'FNH:1',
  'DA:1,1',
  'DA:2,1',
  'DA:3,0',
  'DA:4,0',
  'DA:5,0',
  'DA:9,0',
  'DA:10,1',
  'BRDA:2,0,0,1',
  'BRDA:2,0,1,0',
  'BRDA:9,1,0,-',
  'LF:7',
  'LH:3',
  'end_of_record',
  'SF:cli/commands/beta.ts',
  'DA:1,0',
  'DA:2,0',
  'LF:2',
  'LH:0',
  'end_of_record',
  '',
].join('\n');

// A second report that covers line 3 of alpha.ts and the branch alpha.ts:2/0/1
// — merging must sum hits and OR branch "taken".
const LCOV_B = ['SF:/ABS_ROOT/lib/alpha.ts', 'DA:3,5', 'BRDA:2,0,1,2', 'end_of_record', ''].join('\n');

describe('scripts/coverageDiffSummary.ts', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-covsum-'));
    writeFileSync(join(dir, 'a.info'), LCOV_A);
    writeFileSync(join(dir, 'b.info'), LCOV_B.replace(/\/ABS_ROOT/g, dir));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('parseLcov', () => {
    it('reads DA/BRDA records, keyed by SF path relative to root', () => {
      const cov = parseLcov(LCOV_A, '/repo');
      expect([...cov.keys()]).toEqual(['lib/alpha.ts', 'cli/commands/beta.ts']);
      const alpha = cov.get('lib/alpha.ts')!;
      expect(alpha.lines.get(1)).toBe(1);
      expect(alpha.lines.get(3)).toBe(0);
      expect(alpha.lines.size).toBe(7);
      expect(alpha.branches.get('2:0:0')).toBe(true);
      expect(alpha.branches.get('2:0:1')).toBe(false);
      expect(alpha.branches.get('9:1:0')).toBe(false); // "-" = never evaluated
    });

    it('merges several documents: hits summed, branch taken OR-ed, absolute SF relativised', () => {
      const cov = parseLcov([LCOV_A, LCOV_B.replace(/\/ABS_ROOT/g, '/repo')], '/repo');
      const alpha = cov.get('lib/alpha.ts')!;
      expect(alpha.lines.get(3)).toBe(5);
      expect(alpha.branches.get('2:0:1')).toBe(true);
      expect(cov.size).toBe(2);
    });

    it('ignores records before the first SF: line', () => {
      expect(parseLcov('DA:1,1\nBRDA:1,0,0,1\nend_of_record\n').size).toBe(0);
    });
  });

  describe('helpers', () => {
    it('normalizePath relativises absolute paths and uses forward slashes', () => {
      expect(normalizePath('/repo/lib/x.ts', '/repo')).toBe('lib/x.ts');
      expect(normalizePath('  lib/x.ts ', '/repo')).toBe('lib/x.ts');
    });

    it('isReportableSource keeps source files and drops tests, types, configs, non-code', () => {
      expect(isReportableSource('lib/alpha.ts')).toBe(true);
      expect(isReportableSource('scripts/coverageDiffSummary.ts')).toBe(true);
      expect(isReportableSource('components/A.tsx')).toBe(true);
      for (const f of [
        'README.md', 'tests/unit/x.test.ts', 'lib/x.test.ts', 'lib/x.spec.ts', 'lib/types.d.ts',
        '.github/workflows/ci.yml', 'jest.config.cjs', '__mocks__/chai.ts', 'tests/e2e/x.ts',
        'server/dist/index.js', 'coverage-cli/lcov.info', 'test/helper.ts',
      ]) {
        expect(isReportableSource(f)).toBe(false);
      }
    });

    it('compactRanges collapses runs and caps the list with "+N more"', () => {
      expect(compactRanges([3, 4, 5, 9, 1, 1])).toBe('1, 3-5, 9');
      expect(compactRanges([])).toBe('');
      const odd = Array.from({ length: 40 }, (_, i) => i * 2 + 1);
      expect(compactRanges(odd)).toBe('1, 3, 5, 7, 9, 11, 13, 15, +32 more');
      expect(compactRanges(odd, { maxRanges: 2 })).toBe('1, 3, +38 more');
    });

    it('summarizeFile classifies lines the way Codecov does, and pct', () => {
      // line 2: DA hit but branches 1/2 → partial; line 9: branches 0/1 → uncovered
      const s = summarizeFile(parseLcov(LCOV_A, '/repo').get('lib/alpha.ts')!);
      expect(s).toEqual({
        linesTotal: 7,
        linesHit: 2,
        uncovered: [3, 4, 5, 9],
        partial: [2],
        branchesTotal: 3,
        branchesHit: 1,
      });
      expect(pct(3, 7)).toBe('42.9%');
      expect(pct(0, 0)).toBe('—');
    });

    it('matches Codecov on a line that executed but whose only branch arm was never taken (the #580 discrepancy)', () => {
      // Real excerpt from scripts/coverageDiffSummary.ts in #580's unit lcov:
      // line 146 `cwd: string = process.cwd()` ran once (DA:146,1) but the
      // default-parameter branch was never taken; line 187 took 1 of 2 arms.
      // Codecov reported "98.29% — 1 Missing and 1 partial" where a DA-only
      // count says 117/117. Both lines must be classified by their branches.
      const lcov = [
        'SF:scripts/lib.ts',
        'DA:146,1',
        'DA:187,5',
        'DA:188,5',
        'BRDA:146,21,0,0',
        'BRDA:187,26,0,0',
        'BRDA:187,26,1,5',
        'end_of_record',
        '',
      ].join('\n');
      const s = summarizeFile(parseLcov(lcov, '/repo').get('scripts/lib.ts')!);
      expect(s.linesTotal).toBe(3);
      expect(s.linesHit).toBe(1);
      expect(s.uncovered).toEqual([146]);
      expect(s.partial).toEqual([187]);
      const md = renderSummary({ title: '', changed: ['scripts/lib.ts'], coverage: parseLcov(lcov, '/repo') });
      expect(md).toContain('| `scripts/lib.ts` | 33.3% (1/3) | 33.3% | 146 | 187 |');
    });

    it('ignores BRDA records on line 1 of a .ts file (as Codecov does) and counts a BRDA-only line', () => {
      const lcov = [
        'SF:lib/one.ts',
        'DA:1,1',
        'DA:2,1',
        'BRDA:1,0,0,0',
        'BRDA:1,0,1,0',
        'BRDA:7,1,0,-',
        'end_of_record',
        'SF:lib/one.js',
        'DA:1,1',
        'BRDA:1,0,0,0',
        'end_of_record',
        '',
      ].join('\n');
      const cov = parseLcov(lcov, '/repo');
      const ts = summarizeFile(cov.get('lib/one.ts')!);
      // line 1 stays covered; line 7 exists only via BRDA and is uncovered (0/1)
      expect(ts).toEqual({ linesTotal: 3, linesHit: 2, uncovered: [7], partial: [], branchesTotal: 1, branchesHit: 0 });
      const js = summarizeFile(cov.get('lib/one.js')!);
      expect(js.uncovered).toEqual([1]);
    });
  });

  describe('renderSummary', () => {
    it('renders lines %, branches % and compact uncovered ranges for changed source files', () => {
      const md = renderSummary({
        title: 'Unit coverage — changed files',
        changed: ['lib/alpha.ts', 'cli/commands/beta.ts'],
        coverage: parseLcov(LCOV_A, '/repo'),
      });
      expect(md).toContain('### Unit coverage — changed files');
      expect(md).toContain('| File | Lines | Branches | Uncovered lines | Partial lines |');
      expect(md).toContain('| `lib/alpha.ts` | 28.6% (2/7) | 33.3% | 3-5, 9 | 2 |');
      expect(md).toContain('| `cli/commands/beta.ts` | 0.0% (0/2) | — | 1-2 | — |');
      expect(md).toContain('| **Total (2 measured)** | **22.2%** (2/9) | **33.3%** | | |');
      expect(md).toContain('_Line status as Codecov counts it');
    });

    it('marks changed source files absent from the report as not measured, skips non-source files, omits the heading without a title', () => {
      const md = renderSummary({
        title: '',
        changed: ['lib/alpha.ts', 'server/routes/gamma.ts', 'README.md', 'tests/unit/x.test.ts', 'lib/types.d.ts'],
        coverage: parseLcov(LCOV_A, '/repo'),
      });
      expect(md).toContain('| `server/routes/gamma.ts` | n/a | n/a | _not measured by this suite_ | |');
      expect(md).not.toContain('README.md');
      expect(md).not.toContain('x.test.ts');
      expect(md).not.toContain('types.d.ts');
      expect(md).not.toContain('### ');
      expect(md).toContain('**Total (1 measured)**');
    });

    it('renders a fully covered file with dashes in both line columns', () => {
      const cov = parseLcov(['SF:lib/full.ts', 'DA:1,1', 'DA:2,3', 'BRDA:2,0,0,1', 'BRDA:2,0,1,2', 'end_of_record', ''].join('\n'), '/repo');
      expect(renderSummary({ title: '', changed: ['lib/full.ts'], coverage: cov })).toContain(
        '| `lib/full.ts` | 100.0% (2/2) | 100.0% | — | — |',
      );
    });

    it('prints a one-line note when the change touches no source files', () => {
      expect(renderSummary({ title: 'T', changed: ['README.md', 'docs/x.md'], coverage: new Map() })).toBe(
        "### T\n\n_No changed source files in this suite's scope._\n",
      );
    });

    it('omits the totals row when nothing was measured', () => {
      const md = renderSummary({ title: '', changed: ['lib/zeta.ts'], coverage: new Map() });
      expect(md).toContain('_not measured by this suite_');
      expect(md).not.toContain('Total');
    });
  });

  describe('parseArgs', () => {
    it('collects repeated --lcov, --files, --base, --title, --root', () => {
      const o = parseArgs(['--lcov', 'a', '--lcov', 'b', '--files', 'x, y,', '--base', 'sha', '--title', 'T', '--root', '/r']);
      expect(o).toEqual({ lcov: ['a', 'b'], files: ['x', 'y'], base: 'sha', title: 'T', root: '/r' });
    });

    it('rejects unknown flags, missing values, missing --lcov, and missing --base/--files', () => {
      expect(() => parseArgs(['--lcov', 'a', '--bogus'])).toThrow(/unknown argument: --bogus/);
      expect(() => parseArgs(['--lcov'])).toThrow(/missing value for --lcov/);
      expect(() => parseArgs(['--files', 'a'])).toThrow(/--lcov <file> is required/);
      expect(() => parseArgs(['--lcov', 'a'])).toThrow(/one of --base <ref> or --files/);
    });
  });

  describe('run', () => {
    it('reads and merges lcov files from disk, relativising against --root', () => {
      const { markdown, warnings } = run([
        '--lcov', join(dir, 'a.info'), '--lcov', join(dir, 'b.info'), '--files', 'lib/alpha.ts', '--root', dir,
      ]);
      expect(warnings).toEqual([]);
      // line 3 now hit (0+5), branch 2/0/1 now taken → line 2 fully covered: 4/7 lines, 2/3 branches, uncovered 4,5,9, no partials
      expect(markdown).toContain('| `lib/alpha.ts` | 57.1% (4/7) | 66.7% | 4-5, 9 | — |');
    });

    it('warns about an unreadable lcov file instead of throwing, and treats it as empty', () => {
      const { markdown, warnings } = run(['--lcov', join(dir, 'missing.info'), '--files', 'lib/alpha.ts']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/cannot read .*missing\.info/);
      expect(markdown).toContain('_not measured by this suite_');
    });

    it('changedFilesFromGit defaults to the current directory (this repo): HEAD vs HEAD is empty', () => {
      expect(changedFilesFromGit('HEAD')).toEqual([]);
    });

    it('derives the changed-file list from `git diff <base> HEAD` when --base is given', () => {
      const repo = join(dir, 'repo');
      mkdirSync(join(repo, 'lib'), { recursive: true });
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
            GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
            GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
          },
        });
      git('init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'lib', 'alpha.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo, 'lib', 'untouched.ts'), 'export const u = 1;\n');
      writeFileSync(join(repo, 'README.md'), '# x\n');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD').trim();
      writeFileSync(join(repo, 'lib', 'alpha.ts'), 'export const a = 2;\n');
      writeFileSync(join(repo, 'README.md'), '# y\n');
      git('add', '.');
      git('commit', '-q', '-m', 'change');
      writeFileSync(join(repo, 'cov.info'), LCOV_A);

      const { markdown } = run(['--lcov', join(repo, 'cov.info'), '--base', base, '--title', 'Git', '--root', repo]);
      expect(markdown).toContain('| `lib/alpha.ts` | 28.6% (2/7) | 33.3% | 3-5, 9 | 2 |');
      expect(markdown).not.toContain('untouched.ts');
      expect(markdown).not.toContain('README');
    });
  });

  describe('CLI entry (scripts/coverage-diff-summary.ts via tsx, as CI runs it)', () => {
    it('prints the table to stdout and exits 0', async () => {
      const r = await runEntry(['--lcov', join(dir, 'a.info'), '--files', 'lib/alpha.ts', '--root', dir, '--title', 'E']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('### E');
      expect(r.stdout).toContain('| `lib/alpha.ts` | 28.6% (2/7) | 33.3% | 3-5, 9 | 2 |');
    }, 60_000);

    it('exits 2 with a usage error on stderr when neither --base nor --files is given', async () => {
      const r = await runEntry(['--lcov', join(dir, 'a.info')]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/one of --base <ref> or --files/);
    }, 60_000);
  });
});
