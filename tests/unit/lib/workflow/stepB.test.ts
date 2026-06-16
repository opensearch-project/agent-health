/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Step B — improve-the-agent tests.
 *
 * Covers the deterministic profiling (reuses #267 spansToTrajectory +
 * scanSessionSignals), the reasoner prompt construction, the edit parser, and
 * deriveAgentEdits with an injected reasoner (no real `claude` process).
 */

import {
  profileSpans,
  buildAgentEditsPrompt,
  parseAgentEdits,
  deriveAgentEdits,
  FeedbackLedger,
  workflow,
  source,
  clearSources,
} from '@/lib/workflow/index.js';
import type { Span } from '@/types/index.js';

// Minimal generic OTel-style spans: one tool action + one errored tool result
// for the same tool → should produce a trajectory and a tool_error_retry-ish
// signal scan (exact signals are #267's concern; we assert structure).
function sessionSpans(sessionId: string): Span[] {
  const base = (over: Partial<Span>): Span => ({
    traceId: `trace-${sessionId}`,
    spanId: Math.random().toString(36).slice(2),
    name: 'gen_ai.execute_tool',
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    attributes: {},
    status: 'OK',
    ...over,
  } as Span);
  return [
    base({ name: 'gen_ai.assistant.message', attributes: { 'gen_ai.completion': 'thinking' } }),
    base({ name: 'gen_ai.execute_tool', attributes: { 'gen_ai.tool.name': 'cs-status' } }),
  ];
}

describe('Step B — profileSpans (deterministic, reuses #267)', () => {
  it('reconstructs a trajectory + signals + traceIds from spans', () => {
    const p = profileSpans('sess-1', sessionSpans('sess-1'), {
      evaluator: { id: 'system-tool-usage', systemPrompt: 'Score tool selection.' },
    });
    expect(p.sessionId).toBe('sess-1');
    expect(Array.isArray(p.trajectory)).toBe(true);
    expect(Array.isArray(p.signals)).toBe(true);
    expect(p.traceIds).toContain('trace-sess-1');
    expect(p.evaluator?.id).toBe('system-tool-usage');
  });
});

describe('Step B — buildAgentEditsPrompt (pure)', () => {
  it('embeds rubric + cumulative ledger + signals', () => {
    const ledger = new FeedbackLedger();
    ledger.append('route lock tickets to the lock SOP, not KMS', { ticketId: 'TT-1' });
    const profiles = [
      profileSpans('sess-1', sessionSpans('sess-1'), {
        evaluator: { id: 'system-tool-usage', systemPrompt: 'RUBRIC-TEXT' },
      }),
    ];
    const prompt = buildAgentEditsPrompt(profiles, { repo: 'AESOncallClaudeCode', ledger });
    expect(prompt).toContain('AESOncallClaudeCode');
    expect(prompt).toContain('RUBRIC-TEXT');
    expect(prompt).toContain('route lock tickets to the lock SOP');
    expect(prompt).toContain('Weight this human feedback ABOVE the signals');
    expect(prompt).toContain('Return ONLY a JSON array');
  });
});

describe('Step B — parseAgentEdits (tolerant)', () => {
  it('parses a fenced JSON array and normalizes priority', () => {
    const raw = 'Here are the edits:\n```json\n[{"file":"context/cp-oncall/prompt.md","change":"add lock disambiguation row","why":"signal: user_redirect on TT-1","priority":"high","evidence":["sess-1"]}]\n```';
    const edits = parseAgentEdits(raw);
    expect(edits.length).toBe(1);
    expect(edits[0].file).toBe('context/cp-oncall/prompt.md');
    expect(edits[0].priority).toBe('high');
    expect(edits[0].evidence).toContain('sess-1');
  });
  it('returns [] on non-JSON output', () => {
    expect(parseAgentEdits('no json here').length).toBe(0);
  });
});

describe('Step B — deriveAgentEdits (injected reasoner)', () => {
  it('builds a prompt and parses the reasoner output', async () => {
    const profiles = [profileSpans('sess-1', sessionSpans('sess-1'), { evaluator: { id: 'e', systemPrompt: 'R' } })];
    let sawPrompt = '';
    const edits = await deriveAgentEdits(profiles, {
      repo: 'AESOncallClaudeCode',
      ledger: new FeedbackLedger(),
      reason: async (prompt) => {
        sawPrompt = prompt;
        return '[{"file":"skills/red-cluster-knowledge/SKILL.md","change":"tighten description","why":"signal","priority":"medium"}]';
      },
    });
    expect(sawPrompt).toContain('AESOncallClaudeCode');
    expect(edits.length).toBe(1);
    expect(edits[0].file).toContain('red-cluster-knowledge');
  });
  it('returns [] for no profiles without calling the reasoner', async () => {
    let called = false;
    const edits = await deriveAgentEdits([], { reason: async () => { called = true; return '[]'; } });
    expect(edits.length).toBe(0);
    expect(called).toBe(false);
  });
});

describe('Step B — wired into the workflow context', () => {
  beforeEach(() => clearSources());

  it('profiles guided sessions + derives edits through wf, end to end', async () => {
    const q = source('noop', async () => []); // Step A not exercised here

    const wf = workflow('improve', { agent: 'aos-oncall', repo: 'AESOncallClaudeCode' })
      .step('improve-the-agent', async (ctx) => {
        const sessions = await ctx.guidedSessions({ since: '24h' });
        expect(sessions.length).toBe(2);
        const edits = await ctx.deriveAgentEdits(sessions, { repo: 'AESOncallClaudeCode' });
        expect(edits.length).toBe(1);
        await ctx.raisePR(edits, { title: 'chore(agent): improvements from guided sessions', repo: ctx.config.repo });
      });

    let prTitle = '';
    void q;
    await wf.run({
      fetchGuidedSessions: async () => [
        { sessionId: 'sess-1', spans: sessionSpans('sess-1'), evaluator: { id: 'e', systemPrompt: 'R' } },
        { sessionId: 'sess-2', spans: sessionSpans('sess-2') },
      ],
      reason: async () => '[{"file":"context/cp-oncall/prompt.md","change":"x","why":"y","priority":"high"}]',
      onPR: async (pr) => { prTitle = pr.title; },
    });
    expect(prTitle).toContain('improvements from guided sessions');
  });
});
