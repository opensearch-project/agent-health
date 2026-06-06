/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { createAgentFixture } from '@/lib/testCases/agentFixture';
import type { AgentRunOptions } from '@/lib/testCases/agentFixture';
import type { EvalResult } from '@/lib/testCases/types';

// Minimal EvalResult stub — the fixture only forwards it.
const stubResult = (output = 'ok'): EvalResult =>
  ({ trajectory: [] as any, agentOutput: output, finalResponse: () => output,
     parsedOutput: () => undefined, rawEvents: [], durationMs: 0 } as EvalResult);

describe('createAgentFixture — one-run-per-test agent fixture', () => {
  it('invokes the supplied callback and returns its result', async () => {
    const calls: Array<{ prompt: string; options?: AgentRunOptions }> = [];
    const agent = createAgentFixture(async (prompt, options) => {
      calls.push({ prompt, options });
      return stubResult('hello');
    });

    expect(agent.invoked).toBe(false);
    const r = await agent.run('do the thing');
    expect(r.agentOutput).toBe('hello');
    expect(agent.invoked).toBe(true);
    expect(calls).toEqual([{ prompt: 'do the thing', options: { context: undefined } }]);
  });

  it('throws on a second run() — exactly one invocation per test', async () => {
    let count = 0;
    const agent = createAgentFixture(async () => { count++; return stubResult(); });

    await agent.run('first');
    await expect(agent.run('second')).rejects.toThrow(/at most once per test/);
    expect(count).toBe(1); // callback never fired the second time
  });

  it('guards re-entrant calls even without awaiting the first', async () => {
    let count = 0;
    const agent = createAgentFixture(async () => {
      count++;
      await new Promise(r => setTimeout(r, 5));
      return stubResult();
    });

    const p1 = agent.run('a');
    // Second call before the first settles must still throw.
    await expect(agent.run('b')).rejects.toThrow(/at most once/);
    await p1;
    expect(count).toBe(1);
  });

  it('uses defaultPrompt when run() is called with no argument', async () => {
    let seen = '';
    const agent = createAgentFixture(async (p) => { seen = p; return stubResult(); },
      { defaultPrompt: 'the default prompt' });
    await agent.run();
    expect(seen).toBe('the default prompt');
  });

  it('throws when no prompt is available (no arg, no defaultPrompt)', async () => {
    const agent = createAgentFixture(async () => stubResult());
    await expect(agent.run()).rejects.toThrow(/requires a prompt/);
  });

  it('merges defaultContext under per-call context', async () => {
    let seen: AgentRunOptions | undefined;
    const agent = createAgentFixture(
      async (_p, opts) => { seen = opts; return stubResult(); },
      { defaultContext: [{ description: 'base', value: 'B' }] },
    );
    await agent.run('p', { context: [{ description: 'extra', value: 'E' }] });
    expect(seen?.context).toEqual([
      { description: 'base', value: 'B' },
      { description: 'extra', value: 'E' },
    ]);
  });

  it('passes undefined context when neither default nor per-call context exists', async () => {
    let seen: AgentRunOptions | undefined;
    const agent = createAgentFixture(async (_p, opts) => { seen = opts; return stubResult(); });
    await agent.run('p');
    expect(seen?.context).toBeUndefined();
  });
});
