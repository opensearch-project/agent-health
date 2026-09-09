/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseRestrictedCommand, RestrictedBash } from '@/server/services/restrictedBash';

let root: string;
let bash: RestrictedBash;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'restricted-bash-test-'));
  await fs.mkdir(path.join(root, 'scratch'));
  bash = await RestrictedBash.createForTesting({ rootDir: root, timeoutMs: 5000, quotaBytes: 100, quotaFiles: 2 });
});

beforeEach(async () => {
  await fs.rm(path.join(root, 'evidence'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'scratch'), { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'evidence', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'scratch'));
  await fs.writeFile(path.join(root, 'evidence', 'words.txt'), 'pear\napple\napple\nBANANA\n');
  await fs.writeFile(path.join(root, 'evidence', 'table.txt'), 'a,3\nb,1\nc,2\n');
  await fs.writeFile(path.join(root, 'evidence', 'nested', 'note.log'), 'before\nneedle\nafter\n');
  await fs.writeFile(path.join(root, 'evidence', 'data.json'), JSON.stringify([
    { type: 'action', toolName: 'read' },
    { type: 'action', toolName: 'read' },
    { type: 'response', content: 'done' },
  ]));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const run = (command: string) => bash.execute(command);

describe('restricted parser', () => {
  it('parses quoted args, pipelines, sequences, redirects, and escaped characters', () => {
    expect(parseRestrictedCommand("grep -i 'hello world' evidence/a | sort && echo ok > scratch/out")).toEqual({
      first: [
        { argv: ['grep', '-i', 'hello world', 'evidence/a'], redirects: [] },
        { argv: ['sort'], redirects: [] },
      ],
      rest: [{ op: '&&', pipeline: [{ argv: ['echo', 'ok'], redirects: [{ kind: '>', path: 'scratch/out' }] }] }],
    });
    expect(parseRestrictedCommand('echo "quoted \\"value\\"" plain\\ value').first[0].argv)
      .toEqual(['echo', 'quoted "value"', 'plain value']);
  });

  it.each([
    ['echo $(id)', /variables|substitution/],
    ['echo `id`', /backticks/],
    ['echo $HOME', /variables/],
    ['(echo x)', /subshell/],
    ['echo x &', /background/],
    ['cat evidence/*.json', /glob expansion/],
    ['echo "unterminated', /unterminated quote/],
    ['echo trailing\\', /trailing escape/],
  ])('rejects unsupported syntax: %s', (command, message) => {
    expect(() => parseRestrictedCommand(command)).toThrow(message as RegExp);
  });
});

describe('restricted commands — golden behavior', () => {
  it('cat, echo, pwd, redirection and sequences', async () => {
    expect((await run('cat evidence/table.txt')).stdout).toBe('a,3\nb,1\nc,2\n');
    expect((await run('echo hello world')).stdout).toBe('hello world\n');
    expect((await run('pwd')).stdout).toBe(`${root}\n`);
    expect((await run('echo one > scratch/out; echo two >> scratch/out; cat scratch/out')).stdout).toBe('one\ntwo\n');
    expect((await run('wc -l < evidence/words.txt')).stdout).toBe('4\n');
    expect((await run('grep missing evidence/words.txt || echo fallback')).stdout).toBe('fallback\n');
    expect((await run('grep apple evidence/words.txt && echo found')).stdout).toBe('apple\napple\nfound\n');
  });

  it('ls and find (-name/-type/-maxdepth) across files and recursive directories', async () => {
    await fs.writeFile(path.join(root, 'evidence', '.hidden'), 'hidden');
    const ls = await run('ls evidence');
    expect(ls.stdout).toContain('data.json');
    expect(ls.stdout).toContain('nested/');
    expect(ls.stdout).not.toContain('.hidden');
    expect((await run('ls -a evidence')).stdout).toContain('.hidden');
    expect((await run('ls -R evidence')).stdout).toContain('evidence/nested:');
    expect((await run('ls evidence/words.txt')).stdout).toBe('evidence/words.txt\n');
    expect((await run('ls evidence evidence/nested')).stdout).toContain('evidence:');
    const find = await run("find evidence -maxdepth 2 -type f -name '*.log'");
    expect(find.stdout).toBe('evidence/nested/note.log\n');
    expect((await run('find evidence/words.txt -type f')).stdout).toBe('evidence/words.txt\n');
  });

  it('grep/rg flags, recursion, context, count, files, fixed and max', async () => {
    expect((await run('grep -in -m 1 apple evidence/words.txt')).stdout).toBe('2:apple\n');
    expect((await run('grep -iv apple evidence/words.txt')).stdout).toContain('pear');
    expect((await run('grep -c apple evidence/words.txt')).stdout).toBe('2\n');
    expect((await run('grep -l needle evidence/nested/note.log')).stdout).toBe('evidence/nested/note.log\n');
    expect((await run('grep -n -C 1 needle evidence/nested/note.log')).stdout).toBe('1:before\n2:needle\n3:after\n');
    expect((await run('grep -n -C1 needle evidence/nested/note.log')).stdout).toBe('1:before\n2:needle\n3:after\n');
    expect((await run('grep -F "a,3" evidence/table.txt')).stdout).toBe('a,3\n');
    expect((await run('rg -r needle evidence')).stdout).toContain('evidence/nested/note.log:needle');
  });

  it('head, tail and wc line/byte/word modes', async () => {
    expect((await run('head -n 2 evidence/words.txt')).stdout).toBe('pear\napple\n');
    expect((await run('tail -n 2 evidence/words.txt')).stdout).toBe('apple\nBANANA\n');
    expect((await run('head -c 4 evidence/words.txt')).stdout).toBe('pear');
    expect((await run('tail -c 7 evidence/words.txt')).stdout).toBe('BANANA\n');
    expect((await run('wc -l evidence/words.txt')).stdout).toBe('4 evidence/words.txt\n');
    expect((await run('echo "one two" | wc -w')).stdout).toBe('2\n');
  });

  it('sort and uniq flags', async () => {
    expect((await run('sort evidence/words.txt | uniq -c')).stdout).toContain('      2 apple');
    expect((await run('sort -t , -k 2 -n evidence/table.txt')).stdout).toBe('b,1\nc,2\na,3\n');
    expect((await run('sort -r -u evidence/words.txt')).stdout.split('\n')[0]).toBe('pear');
    expect((await run('sort evidence/words.txt | uniq -d')).stdout).toBe('apple\n');
  });

  it('cut, tr and sed subsets', async () => {
    expect((await run('cut -d , -f 1 evidence/table.txt')).stdout).toBe('a\nb\nc\n');
    expect((await run('echo abc | cut -c 2-3')).stdout).toBe('bc\n');
    expect((await run("echo abc | tr 'a-c' 'A-C'")).stdout).toBe('ABC\n');
    expect((await run("echo banana | tr -d 'a'")).stdout).toBe('bnn\n');
    expect((await run("sed -n '2,3p' evidence/words.txt")).stdout).toBe('apple\napple\n');
    expect((await run("sed 's/apple/pear/g' evidence/words.txt")).stderr).toMatch(/regex is disabled/);
  });

  it('runs real jq-wasm and composes a useful evidence pipeline', async () => {
    const result = await run("jq -r '.[] | select(.type==\"action\") | .toolName' evidence/data.json | sort | uniq -c");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('      2 read\n');
  });
});

describe('confinement and failure semantics', () => {
  it('rejects `cat /etc/passwd` and .. path escapes', async () => {
    expect((await run('cat ../etc/passwd')).stderr).toMatch(/path escape rejected/);
    expect((await run('cat /etc/passwd')).stderr).toMatch(/outside judgment directory/);
  });

  it('rejects symlinks instead of following them', async () => {
    await fs.symlink('/etc/passwd', path.join(root, 'evidence', 'link'));
    expect((await run('cat evidence/link')).stderr).toMatch(/symlinks are not allowed/);
  });

  it('lists and reads exact canonical files through a zero-copy read-only mount', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restricted-mount-store-'));
    const source1 = path.join(traceDir, 'session-one.ndjson');
    const source2 = path.join(traceDir, 'session-two.ndjson');
    const sibling = path.join(traceDir, 'another-session.ndjson');
    await fs.writeFile(source1, '{"spanId":"s1","durationMs":3}\n');
    await fs.writeFile(source2, '{"spanId":"s2","durationMs":4}\n');
    await fs.writeFile(sibling, '{"spanId":"SECRET"}\n');
    try {
      const mounted = await RestrictedBash.createForTesting({
        rootDir: root,
        mounts: [{ virtualPath: 'evidence/spans.ndjson', sourcePaths: [source1, source2] }],
      });
      expect((await mounted.execute('ls evidence')).stdout).toContain('spans.ndjson');
      expect((await mounted.execute('ls evidence/spans.ndjson')).stdout).toBe('evidence/spans.ndjson\n');
      expect((await mounted.execute('ls -l evidence/spans.ndjson')).stdout).toMatch(/-r--r--r--\s+\d+ spans\.ndjson/);
      expect((await mounted.execute("jq -s 'map(.durationMs) | add' evidence/spans.ndjson")).stdout.trim()).toBe('7');
      expect((await mounted.execute('find evidence -maxdepth 1 -type f')).stdout).toContain('evidence/spans.ndjson');
      // The virtual entry has no inode in the judgment tmpdir: the resolver,
      // not a symlink or copy, provides the bytes.
      await expect(fs.lstat(path.join(root, 'evidence', 'spans.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await mounted.execute('echo x > evidence/spans.ndjson')).stderr).toMatch(/writes are allowed only under scratch/);
    } finally {
      await fs.rm(traceDir, { recursive: true, force: true });
    }
  });

  it('mounts a workspace directory read-only without copying or escaping its root', async () => {
    const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), 'restricted-workspace-store-'));
    const workspace = path.join(workspaceParent, 'run-workspace');
    const sibling = path.join(workspaceParent, 'sibling-secret.txt');
    await fs.mkdir(path.join(workspace, 'nested'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'nested', 'events.ndjson'), '{"kind":"tool","ok":true}\n');
    await fs.writeFile(path.join(workspace, 'notes.txt'), 'alpha\nneedle\n');
    await fs.writeFile(sibling, 'SECRET\n');

    // A sparse file proves mount creation does not copy or apply evidence-size
    // limits; individual commands retain their normal bounded-input limits.
    await fs.writeFile(path.join(workspace, 'large.bin'), '');
    await fs.truncate(path.join(workspace, 'large.bin'), 32 * 1024 * 1024);
    try {
      const mounted = await RestrictedBash.createForTesting({
        rootDir: root,
        mounts: [{ virtualPath: 'evidence/workspace', sourcePaths: [workspace] }],
        maxFileBytes: 32,
      });
      expect((await mounted.execute('ls evidence')).stdout).toContain('workspace/');
      expect((await mounted.execute('ls evidence/workspace')).stdout).toContain('nested/');
      expect((await mounted.execute('cat evidence/workspace/notes.txt')).stdout).toContain('needle');
      expect((await mounted.execute('grep needle evidence/workspace/notes.txt')).stdout).toBe('needle\n');
      expect((await mounted.execute('rg -r tool evidence/workspace/nested')).stdout).toContain('events.ndjson');
      expect((await mounted.execute("jq -r '.kind' evidence/workspace/nested/events.ndjson")).stdout.trim()).toBe('tool');
      expect((await mounted.execute("find evidence/workspace -type f -name '*.ndjson'")).stdout)
        .toBe('evidence/workspace/nested/events.ndjson\n');
      expect((await mounted.execute('find evidence -maxdepth 2 -type f')).stdout).toContain('evidence/workspace/notes.txt');
      expect((await mounted.execute('ls -l evidence/workspace/large.bin')).exitCode).toBe(0);

      expect((await mounted.execute('cat evidence/workspace/../sibling-secret.txt')).stderr).toMatch(/path escape rejected/);
      expect((await mounted.execute('cat evidence/sibling-secret.txt')).stderr).toMatch(/no such file/);
      expect((await mounted.execute(`cat ${sibling}`)).stderr).toMatch(/outside judgment directory/);
      await fs.symlink(sibling, path.join(workspace, 'escape-link'));
      expect((await mounted.execute('cat evidence/workspace/escape-link')).stderr).toMatch(/symlinks are not allowed/);
      expect((await mounted.execute('echo changed > evidence/workspace/notes.txt')).stderr)
        .toMatch(/writes are allowed only under scratch/);
      await expect(fs.lstat(path.join(root, 'evidence', 'workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(workspaceParent, { recursive: true, force: true });
    }
  });

  it('a mounted canonical file cannot be pivoted to a sibling trace-store file', async () => {
    const traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'restricted-mount-escape-'));
    const allowed = path.join(traceDir, 'allowed.ndjson');
    const sibling = path.join(traceDir, 'other-session.ndjson');
    await fs.writeFile(allowed, '{"spanId":"allowed"}\n');
    await fs.writeFile(sibling, '{"spanId":"SECRET"}\n');
    try {
      const mounted = await RestrictedBash.createForTesting({
        rootDir: root,
        mounts: [{ virtualPath: 'evidence/spans.ndjson', sourcePaths: [allowed] }],
      });
      expect((await mounted.execute('cat evidence/spans.ndjson')).stdout).toContain('allowed');
      expect((await mounted.execute('cat evidence/spans.ndjson/../other-session.ndjson')).stderr).toMatch(/path escape rejected/);
      expect((await mounted.execute('cat evidence/other-session.ndjson')).stderr).toMatch(/no such file/);
      expect((await mounted.execute(`cat ${sibling}`)).stderr).toMatch(/outside judgment directory/);
      expect((await mounted.execute('rg SECRET evidence')).stdout).toBe('');
      await fs.rm(allowed);
      await fs.symlink(sibling, allowed);
      const swapped = await mounted.execute('cat evidence/spans.ndjson');
      expect(swapped.stderr).toMatch(/no longer the exact allowed inode/);
      expect(swapped.stdout).not.toContain('SECRET');
    } finally {
      await fs.rm(traceDir, { recursive: true, force: true });
    }
  });

  it('rejects `echo x > evidence/t` and all writes outside scratch', async () => {
    expect((await run('echo x > evidence/t')).stderr).toMatch(/writes are allowed only under scratch/);
    expect((await run(`echo x > ${path.join(root, 'outside')}`)).stderr).toMatch(/writes are allowed only under scratch/);
  });

  it('enforces byte and file quota', async () => {
    expect((await run(`echo ${'x'.repeat(101)} > scratch/large`)).stderr).toMatch(/quota exceeded/);
    await run('echo a > scratch/one');
    await run('echo b > scratch/two');
    expect((await run('echo c > scratch/three')).stderr).toMatch(/quota exceeded/);
  });

  it.each(['(a|b){1,10}{1,10}', '(a+)+', '(a|aa)+$'])(
    'treats catastrophic grep/rg patterns as fixed strings: %s', async (pattern) => {
      const started = Date.now();
      for (const engine of ['grep', 'rg']) {
        const result = await bash.execute(`${engine} '${pattern}' evidence/words.txt`);
        expect(result.exitCode).toBe(1);
      }
      expect(Date.now() - started).toBeLessThan(8_000);
    }
  );

  it('rejects every regex flag and sed substitution structurally', async () => {
    for (const command of ["grep -E '(a+)+' evidence/words.txt", "grep -P x evidence/words.txt", "rg -G x evidence/words.txt", "sed 's/(a+)+/x/' evidence/words.txt"]) {
      expect((await bash.execute(command)).stderr).toMatch(/regex.*disabled|regex flags are disabled/);
    }
  });

  it('rejects encoded traversal and hard-linked mounted files', async () => {
    expect((await run('cat evidence/%2e%2e/secret')).stderr).toMatch(/path escape rejected/);
    const outside = path.join(root, 'outside-file');
    const alias = path.join(root, 'alias-file');
    await fs.writeFile(outside, 'secret');
    await fs.link(outside, alias);
    await expect(RestrictedBash.create({ rootDir: root, mounts: [{ virtualPath: 'evidence/alias', sourcePaths: [alias] }] }))
      .rejects.toThrow(/hard-linked/);
  });

  it('validates every mount declaration before exposing canonical evidence', async () => {
    const source = path.join(root, 'evidence', 'words.txt');
    const create = (...mounts: Array<{ virtualPath: string; sourcePaths: string[] }>) =>
      RestrictedBash.create({ rootDir: root, mounts });

    await expect(create({ virtualPath: '', sourcePaths: [source] })).rejects.toThrow(/invalid mount path/);
    await expect(create({ virtualPath: 'scratch/trace', sourcePaths: [source] })).rejects.toThrow(/must be read-only/);
    await expect(create(
      { virtualPath: 'evidence/a', sourcePaths: [source] },
      { virtualPath: 'evidence/a/nested', sourcePaths: [source] }
    )).rejects.toThrow(/overlapping mount/);
    await expect(create({ virtualPath: 'evidence/words.txt', sourcePaths: [source] })).rejects.toThrow(/shadows a physical entry/);
    await expect(create({ virtualPath: 'missing/trace', sourcePaths: [source] })).rejects.toThrow(/mount parent/);
    await expect(create({ virtualPath: 'evidence/empty', sourcePaths: [] })).rejects.toThrow(/has no sources/);
    await expect(create({ virtualPath: 'evidence/directory-as-file', sourcePaths: [path.dirname(source), source] }))
      .rejects.toThrow(/regular non-symlink file/);
  });

  it('keeps in-process execution unavailable outside the test environment', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(RestrictedBash.createForTesting({ rootDir: root })).rejects.toThrow(/only under the test environment/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('reports invalid builtin options without escaping the interpreter', async () => {
    const cases: Array<[string, RegExp]> = [
      ['pwd extra', /too many arguments/],
      ['ls -z evidence', /unsupported flag -z/],
      ['find evidence -wat nope', /unsupported expression/],
      ['find evidence -name', /requires a value/],
      ['grep -m nope apple evidence/words.txt', /requires a number/],
      ['grep -q apple evidence/words.txt', /unsupported flag -q/],
      ['grep', /missing pattern/],
      ['head -n nope evidence/words.txt', /invalid count/],
      ['wc -z evidence/words.txt', /unsupported flag -z/],
      ['sort -z evidence/words.txt', /unsupported flag -z/],
      ['uniq -z evidence/words.txt', /unsupported flag -z/],
      ['cut evidence/words.txt', /specify exactly one/],
      ['tr only-one-set', /expected tr/],
    ];
    for (const [command, error] of cases) {
      const result = await run(command);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(error);
    }
  });

  it('rejects hardlinks within directory mounts both at snapshot and after mount', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'restricted-hardlink-workspace-'));
    const file = path.join(workspace, 'allowed.txt');
    await fs.writeFile(file, 'allowed');
    await fs.link(file, path.join(workspace, 'alias.txt'));
    await expect(RestrictedBash.create({ rootDir: root, mounts: [{ virtualPath: 'evidence/workspace', sourcePaths: [workspace] }] }))
      .rejects.toThrow(/hard-linked/);
    await fs.unlink(path.join(workspace, 'alias.txt'));
    const mounted = await RestrictedBash.createForTesting({ rootDir: root, mounts: [{ virtualPath: 'evidence/workspace', sourcePaths: [workspace] }] });
    await fs.link(file, path.join(workspace, 'late-alias.txt'));
    expect((await mounted.execute('cat evidence/workspace/allowed.txt')).stderr).toMatch(/snapshot inode/);
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('accounts for nested scratch files when enforcing quotas', async () => {
    await fs.mkdir(path.join(root, 'scratch', 'nested'));
    await fs.writeFile(path.join(root, 'scratch', 'nested', 'existing.txt'), '12345');
    const limited = await RestrictedBash.createForTesting({ rootDir: root, quotaBytes: 8 });
    expect((await limited.execute('echo 1234 > scratch/new.txt')).stderr).toMatch(/quota exceeded/);
  });

  it('returns immediately when configured with a zero command timeout', async () => {
    const limited = await RestrictedBash.createForTesting({ rootDir: root, timeoutMs: 0 });
    expect((await limited.execute('echo never')).stderr).toMatch(/timed out after 0ms/);
  });

  it('rejects oversized files before reading them into memory', async () => {
    await fs.writeFile(path.join(root, 'large.txt'), 'x'.repeat(33));
    const limited = await RestrictedBash.createForTesting({ rootDir: root, maxFileBytes: 32, maxInputBytes: 64 });
    const result = await limited.execute('cat large.txt');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/per-file limit 32.*narrow or split/);
  });

  it('rejects an oversized aggregate input set', async () => {
    await fs.writeFile(path.join(root, 'one.txt'), '1'.repeat(24));
    await fs.writeFile(path.join(root, 'two.txt'), '2'.repeat(24));
    const limited = await RestrictedBash.createForTesting({ rootDir: root, timeoutMs: 5000, maxFileBytes: 32, maxInputBytes: 40 });
    const result = await limited.execute('cat one.txt two.txt');
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/inputs exceed 40 bytes.*find\/head/);
  });

  it('preemptively terminates a CPU-heavy non-jq pipeline and observes worker exit', async () => {
    const big = path.join(root, 'big.txt');
    await fs.writeFile(big, Array.from({ length: 300_000 }, (_, i) => `${300_000 - i} value`).join('\n'));
    let exited = false;
    const limited = await RestrictedBash.create({
      rootDir: root, timeoutMs: 50, maxFileBytes: 64 * 1024 * 1024,
      maxInputBytes: 64 * 1024 * 1024, onWorkerExit: () => { exited = true; },
    });
    expect((await limited.execute('echo warm')).stdout).toBe('warm\n');
    const started = Date.now();
    const result = await limited.execute('sort big.txt | uniq -c | sort -rn');
    expect(result.stderr).toMatch(/timed out/);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(500);
    expect(exited).toBe(true);
  });

  it('preemptively terminates a deep find traversal', async () => {
    let dir = path.join(root, 'deep');
    await fs.mkdir(dir);
    for (let i = 0; i < 150; i++) { dir = path.join(dir, `d${i}`); await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'x'), 'x'); }
    let exited = false;
    const limited = await RestrictedBash.create({ rootDir: root, timeoutMs: 10, onWorkerExit: () => { exited = true; } });
    expect((await limited.execute('echo warm')).stdout).toBe('warm\n');
    const started = Date.now();
    const result = await limited.execute('find deep -type f');
    expect(result.stderr).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(410);
    expect(exited).toBe(true);
  });

  it('reuses a worker for a flood of cheap commands', async () => {
    const started = Date.now();
    for (let i = 0; i < 50; i++) expect((await bash.execute('cat evidence/data.json')).exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not bill fresh-worker startup against a tiny command deadline', async () => {
    const fresh = await RestrictedBash.create({ rootDir: root, timeoutMs: 50 });
    const result = await fresh.execute('echo worker-ok');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('worker-ok\n');
  });

  it('preemptively terminates a busy jq worker', async () => {
    const limited = await RestrictedBash.create({ rootDir: root, timeoutMs: 100 });
    expect((await limited.execute('echo warm')).stdout).toBe('warm\n');
    const started = Date.now();
    const result = await limited.execute("jq -n '[range(1000000000)] | length'");
    expect(result.stderr).toMatch(/timed out/);
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(750);
  });

  it('enforces command-count and cumulative judgment budgets', async () => {
    const countLimited = await RestrictedBash.createForTesting({ rootDir: root, maxCommands: 2 });
    expect((await countLimited.execute('echo one')).exitCode).toBe(0);
    expect((await countLimited.execute('echo two')).exitCode).toBe(0);
    const refused = await countLimited.execute('echo three');
    expect(refused.stderr).toMatch(/command budget exhausted/);
    expect(refused.breach).toBe('command-count');

    const timeLimited = await RestrictedBash.createForTesting({ rootDir: root, maxTotalMs: 0 });
    const timed = await timeLimited.execute('echo never');
    expect(timed.stderr).toMatch(/time budget exhausted/);
    expect(timed.breach).toBe('total-time');
  });

  it('reports unknown commands, cd, and output truncation instructively', async () => {
    expect((await run('python3 -V')).text).toMatch(/python3: command not found.*available: jq|available: cat/);
    expect((await run('cd evidence')).stderr).toMatch(/cwd is fixed/);
    const capped = await RestrictedBash.createForTesting({ rootDir: root, outputCapBytes: 80 });
    expect((await capped.execute('cat evidence/words.txt evidence/words.txt evidence/words.txt evidence/words.txt')).text)
      .toMatch(/output truncated.*narrow the query/);
  });

  it('new interpreter modules never import child_process', async () => {
    for (const file of ['restrictedBash.ts', 'evidenceJudgeTools.ts', 'judgeEvidence.ts']) {
      const source = await fs.readFile(path.join(process.cwd(), 'server', 'services', file), 'utf8');
      expect(source).not.toMatch(/(?:node:)?child_process|\bspawn\s*\(|\bexec(?:File)?\s*\(|\bfork\s*\(/);
    }
  });
});
