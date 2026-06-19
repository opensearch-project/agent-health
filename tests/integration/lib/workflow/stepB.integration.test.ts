/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Step B (#278) — INTEGRATION.
 *
 * Drives the full improve-the-agent pipeline through wf.run():
 *
 *   run({ fetchGuidedSessions }) → ctx.guidedSessions()  [real profileSpans, #267]
 *     → ctx.deriveAgentEdits()  [real buildAgentEditsPrompt + parseAgentEdits]
 *       → reason() seam (deterministic; stands in for the claude reasoner)
 *         → ctx.raisePR()
 *
 * Everything is real except the reasoner (which would otherwise spawn `claude`).
 * Also asserts the case-insensitive `priority` normalization fix.
 */

import { workflow, source, clearSources } from '@/lib/workflow/index.js';
import type { Span } from '@/types/index.js';

function sessionSpans(sessionId: string): Span[] {
  const base = (over: Partial<Span>): Span =>
    ({
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
    base({ name: 'gen_ai.assistant.message', attributes: { 'gen_ai.completion': 'investigating' } }),
    base({ name: 'gen_ai.execute_tool', attributes: { 'gen_ai.tool.name': 'cs-domain-manager-status' } }),
    // An errored tool call → exercises the deterministic signal scan.
    base({ name: 'gen_ai.execute_tool', attributes: { 'gen_ai.tool.name': 'tumbler' }, status: 'ERROR' }),
  ];
}

describe('workflow Step B — integration (real profiling pipeline through wf.run)', () => {
  beforeEach(() => clearSources());

  it('profiles guided sessions, derives edits, normalizes priority, raises a PR', async () => {
    // Step A is irrelevant here; the source is empty.
    void source('noop', async () => []);

    let capturedPrompt = '';
    let prTitle = '';
    let prBody = '';
    let editsRaised: any[] = [];

    const wf = workflow('integ-B', { agent: 'aos-oncall', evaluator: 'system-tool-usage', repo: 'AESOncallClaudeCode' })
      .step('improve-the-agent', async (ctx) => {
        // Cumulative human feedback lives on the context ledger; deriveAgentEdits
        // auto-folds it into the reasoner prompt.
        ctx.ledger().append('route lock-timeout tickets to the lock SOP, not KMS', { ticketId: 'TT-9' });
        const profiles = await ctx.guidedSessions({ since: '24h' });
        // Real profileSpans ran: each profile has a reconstructed trajectory + traceIds.
        expect(profiles.length).toBe(2);
        expect(profiles.every((p: any) => Array.isArray(p.trajectory) && p.traceIds.length > 0)).toBe(true);

        const edits = await ctx.deriveAgentEdits(profiles, { repo: ctx.config.repo });
        editsRaised = edits;
        if (edits.length === 0) return;
        await ctx.raisePR(edits, {
          repo: ctx.config.repo,
          title: "chore(aos-oncall): improvements from today's guided sessions",
          body: ctx.ledger().render(),
        });
      });

    await wf.run({
      fetchGuidedSessions: async () => [
        { sessionId: 'sess-1', spans: sessionSpans('sess-1'), evaluator: { id: 'system-tool-usage', systemPrompt: 'RUBRIC-FOR-TOOL-USAGE' } },
        { sessionId: 'sess-2', spans: sessionSpans('sess-2') },
      ],
      // Deterministic stand-in for the claude reasoner. Emits MIXED-CASE priorities
      // to exercise the case-insensitive normalization fix.
      reason: async (prompt: string) => {
        capturedPrompt = prompt;
        return [
          '```json',
          JSON.stringify([
            { file: 'context/dp-oncall/tumbler-primer.md', change: 'document tumbler retry', why: 'signal: tool_error on tumbler', priority: 'HIGH', evidence: ['sess-1'] },
            { file: 'skills/lock-knowledge/SKILL.md', change: 'add lock SOP routing', why: 'human feedback TT-9', priority: 'Low', evidence: ['sess-2'] },
          ]),
          '```',
        ].join('\n');
      },
      onPR: async (pr) => { prTitle = pr.title; prBody = pr.body ?? ''; },
    });

    // The REAL buildAgentEditsPrompt embedded the rubric + the cumulative ledger.
    expect(capturedPrompt).toContain('RUBRIC-FOR-TOOL-USAGE');
    expect(capturedPrompt).toContain('route lock-timeout tickets to the lock SOP');
    expect(capturedPrompt).toContain('AESOncallClaudeCode');

    // parseAgentEdits parsed both edits and normalized mixed-case priorities.
    expect(editsRaised.length).toBe(2);
    expect(editsRaised.map((e) => e.priority).sort()).toEqual(['high', 'low']);

    // A single consolidated improvement PR was raised, carrying the ledger.
    expect(prTitle).toContain('improvements from');
    expect(prBody).toContain('route lock-timeout tickets to the lock SOP');
  });

  it('no guided sessions → no reasoner call, no PR', async () => {
    let reasoned = false;
    let prs = 0;
    const wf = workflow('integ-B-empty', { agent: 'aos-oncall', repo: 'AESOncallClaudeCode' }).step(
      'improve-the-agent',
      async (ctx) => {
        const profiles = await ctx.guidedSessions({ since: '24h' });
        const edits = await ctx.deriveAgentEdits(profiles, { repo: ctx.config.repo });
        if (edits.length > 0) await ctx.raisePR(edits, { repo: ctx.config.repo, title: 'x' });
      }
    );
    await wf.run({
      fetchGuidedSessions: async () => [],
      reason: async () => { reasoned = true; return '[]'; },
      onPR: async () => { prs++; },
    });
    expect(reasoned).toBe(false);
    expect(prs).toBe(0);
  });
});
