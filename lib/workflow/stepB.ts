/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Step B — improve-the-agent from its own guided sessions.
 *
 * This is the successor half of the workflow that builds on the agent-profiling
 * primitives (#267): profile a session's traces against an evaluator rubric,
 * fold in the cumulative FeedbackLedger, and derive concrete edits to the
 * agent's OWN repo (prompt / skills / SOPs) — terminating in an improvement PR.
 *
 * The reasoning node (`deriveAgentEdits`) is the only stochastic part; the
 * profiling is deterministic (reuses `spansToTrajectory` + `scanSessionSignals`
 * from #267). Both the span source and the reasoner are injectable seams so the
 * core is unit-testable without a live server or a real `claude` process.
 */

import type { Span, TrajectoryStep } from '@/types/index.js';
import { spansToTrajectory, scanSessionSignals, type SessionSignal } from '@/services/traces/spansToTrajectory.js';
import type { FeedbackLedger } from './ledger.js';

/** A profiled session — the deterministic half of Step B. */
export interface SessionProfile {
  sessionId: string;
  serviceName?: string;
  trajectory: TrajectoryStep[];
  signals: SessionSignal[];
  evaluator?: { id: string; systemPrompt?: string };
  traceIds: string[];
}

/** A single proposed edit to the agent's repo. */
export interface AgentEdit {
  file: string;
  change: string;
  why: string;
  priority: 'high' | 'medium' | 'low';
  evidence?: string[];
}

/** Reasoner seam: prompt → raw model text. Default spawns `claude -p`. */
export type ReasonFn = (prompt: string) => Promise<string>;

/**
 * Profile a session from its spans — deterministic, reuses #267 primitives.
 * Pass `spans` directly (unit-testable) or resolve them via a seam upstream.
 */
export function profileSpans(
  sessionId: string,
  spans: Span[],
  opts: { serviceName?: string; evaluator?: { id: string; systemPrompt?: string } } = {}
): SessionProfile {
  const trajectory = spansToTrajectory(spans, opts.serviceName);
  const signals = scanSessionSignals(spans, opts.serviceName);
  const traceIds = [...new Set(spans.map((s) => s.traceId).filter(Boolean))];
  return {
    sessionId,
    serviceName: opts.serviceName,
    trajectory,
    signals,
    evaluator: opts.evaluator,
    traceIds,
  };
}

/**
 * Build the reasoner prompt from profiles + the cumulative ledger. Pure, so the
 * exact instruction surface is unit-testable and reviewable.
 */
export function buildAgentEditsPrompt(
  profiles: SessionProfile[],
  opts: { repo?: string; ledger?: FeedbackLedger } = {}
): string {
  const rubric = profiles.find((p) => p.evaluator?.systemPrompt)?.evaluator?.systemPrompt;
  const ledger = opts.ledger?.render();

  const signalLines = profiles.flatMap((p) =>
    p.signals.map((s) => `  - [${s.severity}] ${p.sessionId}: ${s.title}`)
  );

  return [
    `You are improving the agent in its OWN repo${opts.repo ? ` (${opts.repo})` : ''}.`,
    '',
    rubric ? `## Rubric (evaluator)\n${rubric}` : '',
    '',
    ledger ? `${ledger}\n(Weight this human feedback ABOVE the signals.)` : '',
    '',
    '## Deterministic signals observed across the profiled sessions',
    signalLines.length ? signalLines.join('\n') : '  (none)',
    '',
    '## Task',
    'Propose concrete, minimal, generalizable edits. Return ONLY a JSON array:',
    '[{ "file": "...", "change": "...", "why": "<tie to a signal/rubric/feedback + cite session ids>", "priority": "high|medium|low", "evidence": ["sessionId/traceId"] }]',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/** Default reasoner: spawn `claude -p <prompt>` and return stdout. */
export const defaultReason: ReasonFn = async (prompt: string) => {
  const { spawn } = await import('child_process');
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', ['-p', prompt, '--model', 'sonnet'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err}`))));
  });
};

/** Parse the reasoner output into AgentEdits (tolerant of fenced JSON). */
export function parseAgentEdits(raw: string): AgentEdit[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.file === 'string' && typeof e.change === 'string')
      .map((e) => ({
        file: e.file,
        change: e.change,
        why: e.why ?? '',
        priority: ((p) => (p === 'high' || p === 'low' ? p : 'medium'))(String(e.priority ?? '').toLowerCase()),
        evidence: Array.isArray(e.evidence) ? e.evidence : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Derive concrete agent-repo edits from session profiles + the cumulative
 * ledger. `reason` is injectable (defaults to `claude -p`).
 */
export async function deriveAgentEdits(
  profiles: SessionProfile[],
  opts: { repo?: string; ledger?: FeedbackLedger; reason?: ReasonFn } = {}
): Promise<AgentEdit[]> {
  if (profiles.length === 0) return [];
  const prompt = buildAgentEditsPrompt(profiles, { repo: opts.repo, ledger: opts.ledger });
  const reason = opts.reason ?? defaultReason;
  const raw = await reason(prompt);
  return parseAgentEdits(raw);
}
