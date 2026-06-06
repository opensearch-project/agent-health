/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { migrateEvalSource } from '@/lib/testCases/codemod';

describe('migrateEvalSource — v1 → v2 control-inversion codemod', () => {
  it('rewrites a prompt-based body using result to agent.run()', () => {
    const src = `
test('rca', { prompt: 'why?' }, async function ({ result, judge }) {
  expect(result.trajectory).to.have.length.greaterThan(0);
  await judge(result, 'identifies cause');
});`;
    const { code, changed, notes } = migrateEvalSource(src, 'x.eval.js');
    expect(changed).toBe(true);
    expect(code).toContain('async function ({ agent, judge })');
    expect(code).toContain('const result = await agent.run();');
    // Body references to result are preserved (now satisfied by the local).
    expect(code).toContain('expect(result.trajectory)');
    expect(notes.join('\n')).toMatch(/migrate rca/);
  });

  it('adds async when the body was synchronous', () => {
    const src = `test('t', { prompt: 'p' }, function ({ result }) {\n  expect(result.agentOutput).to.exist;\n});`;
    const { code } = migrateEvalSource(src, 'x.eval.js');
    expect(code).toContain('async function ({ agent })');
    expect(code).toContain('const result = await agent.run();');
  });

  it('handles arrow function bodies', () => {
    const src = `test('t', { prompt: 'p' }, async ({ result }) => {\n  expect(result.durationMs).to.be.below(1000);\n});`;
    const { code } = migrateEvalSource(src, 'x.eval.js');
    expect(code).toContain('async ({ agent }) =>');
    expect(code).toContain('const result = await agent.run();');
  });

  it('flags a half-migrated body (agent.run() + still destructures result) for manual review', () => {
    const src = `test('t', { prompt: 'p' }, async ({ agent, result, judge }) => {\n  const r = await agent.run();\n  void result; void judge;\n});`;
    // Half-migrated: agent.run() is in but `result` is still destructured (and
    // would silently read an empty placeholder). The codemod can't safely
    // rewrite those reads, so it surfaces a review note instead of claiming
    // "already migrated" (#4).
    const { changed, notes } = migrateEvalSource(src, 'x.eval.js');
    expect(changed).toBe(false);
    expect(notes.join('\n')).toMatch(/review.*half-migrated/);
  });

  it('skips a fully-migrated body (agent.run() and no result binding)', () => {
    const src = `test('t', { prompt: 'p' }, async ({ agent, judge }) => {\n  const r = await agent.run();\n  void r; void judge;\n});`;
    const { changed, notes } = migrateEvalSource(src, 'x.eval.js');
    expect(changed).toBe(false);
    expect(notes.join('\n')).toMatch(/already migrated/);
  });

  it('leaves no-prompt (data-only) tests untouched', () => {
    const src = `test('data', { labels: ['x'] }, ({ result }) => {\n  expect(result.durationMs).to.equal(0);\n});`;
    const { changed, notes } = migrateEvalSource(src, 'x.eval.js');
    expect(changed).toBe(false);
    expect(notes.join('\n')).toMatch(/no prompt/);
  });

  it('leaves bodies that do not use result untouched', () => {
    const src = `test('t', { prompt: 'p' }, ({ judge }) => { void judge; });`;
    const { changed } = migrateEvalSource(src, 'x.eval.js');
    expect(changed).toBe(false);
  });

  it('is idempotent — running twice yields the same output', () => {
    const src = `test('t', { prompt: 'p' }, async function ({ result }) {\n  expect(result.agentOutput).to.exist;\n});`;
    const once = migrateEvalSource(src, 'x.eval.js').code;
    const twice = migrateEvalSource(once, 'x.eval.js');
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once);
  });

  it('migrates multiple tests in one file', () => {
    const src = `
test('a', { prompt: 'p' }, ({ result }) => { expect(result.agentOutput).to.exist; });
test('b', { prompt: 'q' }, async ({ result, traces }) => { expect(traces.totalTokens).to.be.below(10); void result; });`;
    const { code, notes } = migrateEvalSource(src, 'x.eval.js');
    expect((code.match(/const result = await agent\.run\(\);/g) || []).length).toBe(2);
    expect(notes.filter(n => n.startsWith('migrate')).length).toBe(2);
  });
});
