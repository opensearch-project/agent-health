/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs the real `scripts/coverage-diff-summary.mjs` as a child process (the
 * way CI invokes it) against hand-written lcov fixtures and a throwaway git
 * repo, and asserts the Markdown it prints. No mocks: the lcov parser, the
 * range compaction, the git diff and the table rendering are all exercised
 * end-to-end.
 */

import { execFile, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'coverage-diff-summary.mjs');

function run(args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? ((err as unknown as { code: number }).code)
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
const LCOV_B = [
  'SF:/ABS_ROOT/lib/alpha.ts',
  'DA:3,5',
  'BRDA:2,0,1,2',
  'end_of_record',
  '',
].join('\n');

describe('scripts/coverage-diff-summary.mjs', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ah-covsum-'));
    writeFileSync(join(dir, 'a.info'), LCOV_A);
    writeFileSync(join(dir, 'b.info'), LCOV_B.replace(/\/ABS_ROOT/g, dir));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders lines %, branches % and compact uncovered ranges for changed source files', async () => {
    const r = await run([
      '--lcov', join(dir, 'a.info'),
      '--title', 'Unit coverage — changed files',
      '--files', 'lib/alpha.ts,cli/commands/beta.ts',
      '--root', dir,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('### Unit coverage — changed files');
    expect(r.stdout).toContain('| File | Lines | Branches | Uncovered lines |');
    // alpha: 7 DA lines, 3 hit → 42.9%; 3 branches, 1 taken → 33.3%; uncovered 3,4,5,9 → "3-5, 9"
    expect(r.stdout).toContain('| `lib/alpha.ts` | 42.9% (3/7) | 33.3% | 3-5, 9 |');
    // beta: 0/2, no branches → "—"
    expect(r.stdout).toContain('| `cli/commands/beta.ts` | 0.0% (0/2) | — | 1-2 |');
    // totals across measured files
    expect(r.stdout).toContain('| **Total (2 measured)** | **33.3%** (3/9) | **33.3%** | |');
  });

  it('merges several lcov inputs (sums hits, ORs branches) and relativises absolute SF paths', async () => {
    const r = await run([
      '--lcov', join(dir, 'a.info'),
      '--lcov', join(dir, 'b.info'),
      '--files', 'lib/alpha.ts',
      '--root', dir,
    ]);
    expect(r.code).toBe(0);
    // line 3 now hit (0+5), branch 2/0/1 now taken → 4/7 lines, 2/3 branches, uncovered 4,5,9
    expect(r.stdout).toContain('| `lib/alpha.ts` | 57.1% (4/7) | 66.7% | 4-5, 9 |');
    expect(r.stdout).not.toContain('### ');
  });

  it('marks changed source files absent from the report as not measured, and skips non-source files', async () => {
    const r = await run([
      '--lcov', join(dir, 'a.info'),
      '--files', 'lib/alpha.ts,server/routes/gamma.ts,README.md,tests/unit/x.test.ts,lib/types.d.ts,.github/workflows/ci.yml,jest.config.cjs',
      '--root', dir,
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('| `server/routes/gamma.ts` | n/a | n/a | _not measured by this suite_ |');
    expect(r.stdout).not.toContain('README.md');
    expect(r.stdout).not.toContain('x.test.ts');
    expect(r.stdout).not.toContain('types.d.ts');
    expect(r.stdout).not.toContain('ci.yml');
    expect(r.stdout).not.toContain('jest.config.cjs');
    expect(r.stdout).toContain('**Total (1 measured)**');
  });

  it('prints a one-line note when the change touches no source files', async () => {
    const r = await run(['--lcov', join(dir, 'a.info'), '--files', 'README.md,docs/x.md', '--title', 'T']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("### T\n\n_No changed source files in this suite's scope._\n");
  });

  it('compacts long uncovered lists to 8 ranges plus a "+N more" tail', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `DA:${i * 2 + 1},0`).join('\n');
    writeFileSync(join(dir, 'long.info'), `SF:lib/long.ts\n${lines}\nend_of_record\n`);
    const r = await run(['--lcov', join(dir, 'long.info'), '--files', 'lib/long.ts', '--root', dir]);
    expect(r.stdout).toContain('| `lib/long.ts` | 0.0% (0/40) | — | 1, 3, 5, 7, 9, 11, 13, 15, +32 more |');
  });

  it('derives the changed-file list from `git diff <base> HEAD` when --base is given', async () => {
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

    const r = await run(['--lcov', 'cov.info', '--base', base, '--title', 'Git'], repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('| `lib/alpha.ts` | 42.9% (3/7) | 33.3% | 3-5, 9 |');
    expect(r.stdout).not.toContain('untouched.ts');
    expect(r.stdout).not.toContain('README');
  });

  it('exits 2 with a usage error when neither --base nor --files is given', async () => {
    const r = await run(['--lcov', join(dir, 'a.info')]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/one of --base <ref> or --files/);
  });
});
