/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Case TL;DR — three plain-language sentences about one test-case run, built
 * deterministically from the report and its test case (no model, no
 * network, no caching). Shown above the "Test Case Definition" in the run
 * inspector:
 *
 *   ASKED   — what the test asked and what it expected
 *   AGENT   — what the agent did (tools) and answered
 *   VERDICT — the judgement and its main reason, or why it was not judged
 *
 * Honesty rules (owner: "errors ⇒ no metrics, never zeros"): agent / judge
 * errors read "Not judged: … — <cause>", never a verdict; the verdict label
 * always comes from the report's own fields; code-SDK reports with no judge
 * prose explain themselves from their checks (lib/judgement/checks.ts).
 *
 * Browser-safe: no node built-ins. Pure functions, unit-tested in
 * tests/unit/lib/caseSummary.test.ts.
 */

import type { CaseSummaryParts, TestCase, TestCaseRun } from '@/types';
import { getJudgeReasoningText } from '@/lib/matchers/judgeAccessor';
import { getFailureStage, getFailureCause } from '@/lib/reportFailure';
import { checkEvidence, checkTitle, isNotReachedMarker, summarizeChecks, firstSentence, splitReasoningSections } from '@/lib/judgement/checks';

export type { CaseSummaryParts };

export interface CaseSummaryInputs {
  testCaseName: string;
  prompt: string;
  expectedOutcomes: string[];
  agentName: string;
  toolsUsed: string[];
  stepCount: number;
  finalAnswer: string;
  verdict: 'passed' | 'failed' | 'not_judged';
  /** Set when verdict is 'not_judged': which stage failed and the cause. */
  notJudged?: { stage: 'agent' | 'judge' | 'trace' | 'pending' | 'unknown'; cause: string };
  score?: number;
  reasoning: string;
}

/** Markdown → plain prose for a quoted snippet: fences dropped, emphasis/list/heading markers removed. */
export function plainText(md: string): string {
  const raw = String(md || '').slice(0, 20_000); // bound the work before any regex runs
  const stripped = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A code-only answer must not read as "no response": fall back to the raw text.
  return stripped || raw.replace(/```/g, '').replace(/\s+/g, ' ').trim();
}

export function truncateForSummary(text: string | undefined | null, max: number): string {
  if (!text) return '';
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** The agent's final answer: the last `response` step, else the last `assistant` step with text. */
export function extractFinalAnswer(report: Pick<TestCaseRun, 'trajectory'>): string {
  const traj = Array.isArray(report.trajectory) ? report.trajectory : [];
  for (const wanted of ['response', 'assistant']) {
    for (let i = traj.length - 1; i >= 0; i--) {
      const s: any = traj[i];
      if (s?.type !== wanted) continue;
      const text = s.content ?? s.text;
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return '';
}

function extractToolsUsed(report: Pick<TestCaseRun, 'trajectory'>): string[] {
  const traj = Array.isArray(report.trajectory) ? report.trajectory : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of traj as any[]) {
    const name = s?.toolName;
    if (typeof name === 'string' && name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * The test-case content THIS report ran against: the version recorded on the
 * report when the test case keeps versions, else the top-level fields.
 */
function executedContent(testCase: TestCase | null | undefined, report: TestCaseRun): { prompt: string; expected: string[] } {
  if (!testCase) return { prompt: '', expected: [] };
  const versions = Array.isArray(testCase.versions) ? testCase.versions : [];
  const wanted = report.testCaseVersion;
  const v: any = (wanted !== undefined && versions.find(x => x.version === wanted))
    || (wanted === undefined || wanted === testCase.currentVersion ? undefined : versions.find(x => x.version === testCase.currentVersion));
  const prompt = (v ? (v.content?.initialPrompt ?? v.initialPrompt) : undefined) ?? testCase.initialPrompt ?? '';
  const expRaw = v ? (v.content?.expectedOutcomes ?? v.expectedOutcomes) : undefined;
  const expected = Array.isArray(expRaw) ? expRaw : Array.isArray(testCase.expectedOutcomes) ? testCase.expectedOutcomes : [];
  return { prompt: typeof prompt === 'string' ? prompt : '', expected: expected.filter((e: unknown) => typeof e === 'string') as string[] };
}

type VerdictClass = Pick<CaseSummaryInputs, 'verdict' | 'notJudged'>;

/**
 * Pass / fail / not judged, from the report's own status fields (the repo
 * rule "errors ⇒ no metrics" — `metricsStatus: 'error'` always wins).
 */
export function classifyVerdict(report: Pick<TestCaseRun, 'status' | 'metricsStatus' | 'failureStage' | 'passFailStatus' | 'traceError' | 'llmJudgeReasoning' | 'error' | 'agentError'>): VerdictClass {
  const stage = getFailureStage(report);
  const errored = report.metricsStatus === 'error' || stage === 'agent' || stage === 'judge' || stage === 'trace';
  const pending = !errored && (report.metricsStatus === 'pending' || report.metricsStatus === 'calculating' || report.status === 'running');
  const hasVerdict = !errored && !pending && (report.passFailStatus === 'passed' || report.passFailStatus === 'failed');
  if (hasVerdict) return { verdict: report.passFailStatus as 'passed' | 'failed' };
  if (pending) {
    return { verdict: 'not_judged', notJudged: { stage: 'pending', cause: report.metricsStatus === 'calculating' ? 'judgement in progress' : report.status === 'running' ? 'run still in progress' : 'waiting for traces' } };
  }
  const cause = getFailureCause(report) || (report.status === 'failed' ? 'the run failed before a verdict was produced' : 'no verdict was recorded');
  return { verdict: 'not_judged', notJudged: { stage: stage ?? 'unknown', cause: truncateForSummary(cause, 300) } };
}

export function buildCaseSummaryInputs(report: TestCaseRun, testCase: TestCase | null | undefined): CaseSummaryInputs {
  const { verdict, notJudged } = classifyVerdict(report);

  const content = executedContent(testCase, report);
  return {
    testCaseName: truncateForSummary(testCase?.name, 160) || report.testCaseId,
    prompt: truncateForSummary(content.prompt, 1500),
    expectedOutcomes: content.expected.map(e => truncateForSummary(e, 200)).filter(Boolean),
    agentName: truncateForSummary(report.agentName, 160) || truncateForSummary(report.agentKey, 160) || 'the agent',
    toolsUsed: extractToolsUsed(report).slice(0, 12).map(t => truncateForSummary(t, 160)),
    stepCount: Array.isArray(report.trajectory) ? report.trajectory.length : 0,
    finalAnswer: truncateForSummary(plainText(extractFinalAnswer(report)), 1500),
    verdict,
    notJudged,
    score: typeof report.score === 'number' && Number.isFinite(report.score) && report.score >= 0 && report.score <= 1 ? report.score : undefined,
    reasoning: verdict === 'not_judged' ? '' : truncateForSummary(getJudgeReasoningText(report), 1500),
  };
}

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return /[.!?…”]$/.test(t) ? t : `${t}.`;
}

export function describeNotJudged(nj: NonNullable<CaseSummaryInputs['notJudged']>): string {
  const cause = nj.cause ? ` — ${nj.cause.replace(/\.$/, '')}` : '';
  switch (nj.stage) {
    case 'agent': return `Not judged: the agent request failed${cause}`;
    case 'judge': return `Not judged: the judge could not produce a verdict${cause}`;
    case 'trace': return `Not judged: traces for the run could not be collected${cause}`;
    case 'pending': return `Not judged yet: ${nj.cause}`;
    default: return `Not judged${cause}`;
  }
}

/**
 * The reason behind a pass/fail verdict: the judge's first sentence when an
 * LLM judge reasoned; otherwise the first failing check (its author label +
 * measured-vs-limit evidence) or the check tally.
 */
function verdictReason(inputs: CaseSummaryInputs, report: TestCaseRun): string {
  if (inputs.reasoning) {
    // Prefer the judge's own Summary/Verdict section when its prose has
    // headings — on the RAW text (the bounded copy has its newlines collapsed).
    const sections = splitReasoningSections(getJudgeReasoningText(report));
    const pick = sections.find(sec => /summary|verdict|conclusion/i.test(sec.title)) || sections[0];
    // Drop a leading heading LINE only (never a bold phrase that starts a sentence).
    const body = (pick?.body || '').replace(/^\s*(?:\*\*[^*\n]+\*\*:?|#{1,4}\s[^\n]+)\s*(?:\n|$)/, '');
    const why = firstSentence(body || inputs.reasoning);
    if (why) return why;
  }
  const s = summarizeChecks(report.matcherResults);
  if (!s.total) return '';
  const failing = (report.matcherResults || []).find(m => !isNotReachedMarker(m) && !m.notApplicable && !m.pass && !m.errored);
  if (failing) {
    const title = checkTitle(failing);
    const ev = checkEvidence(failing);
    const head = `${s.failed} of ${s.total} check${s.total === 1 ? '' : 's'} failed`;
    const detail = ev ? `${title}: ${ev}` : title;
    return `${head} — ${truncateForSummary(detail, 220)}`;
  }
  if (s.errored) return `${s.errored} of ${s.total} check${s.total === 1 ? '' : 's'} could not be evaluated`;
  return `all ${s.total} check${s.total === 1 ? '' : 's'} passed`;
}

/**
 * The ONLY place the verdict sentence is written: the label (PASSED / FAILED
 * / Not judged + stage + cause) comes from the report's own fields.
 */
export function composeVerdict(inputs: CaseSummaryInputs, reason: string, judgedByChecksOnly: boolean): string {
  if (inputs.verdict === 'not_judged') {
    return sentence(describeNotJudged(inputs.notJudged ?? { stage: 'unknown', cause: 'no verdict was recorded' }));
  }
  const label = inputs.verdict === 'passed' ? 'PASSED' : 'FAILED';
  const score = typeof inputs.score === 'number' ? ` (score ${Math.round(inputs.score * 100)}%)` : '';
  const head = judgedByChecksOnly ? 'Verdict' : 'Judge verdict';
  const why = reason.trim().replace(/\.$/, '');
  return sentence(`${head}: ${label}${score}${why ? ` — ${why}` : ''}`);
}

/**
 * Build the three sentences. `reason` (optional) replaces the deterministic
 * "why" of a pass/fail verdict — the model-written reason in the hybrid
 * design — but never the label; for unjudged runs it is ignored.
 */
export function buildCaseSummary(report: TestCaseRun, testCase: TestCase | null | undefined, reason?: string): CaseSummaryParts {
  const inputs = buildCaseSummaryInputs(report, testCase);

  const askedCore = inputs.prompt
    ? `The test asks: “${truncateForSummary(inputs.prompt, 240)}”`
    : `The test “${inputs.testCaseName}” has no recorded prompt`;
  const expect = inputs.expectedOutcomes.length === 1
    ? ` Expected outcome: “${truncateForSummary(inputs.expectedOutcomes[0], 160).replace(/\.$/, '')}”.`
    : inputs.expectedOutcomes.length > 1
      ? ` It has ${inputs.expectedOutcomes.length} expected outcomes, e.g. “${truncateForSummary(inputs.expectedOutcomes[0], 120).replace(/\.$/, '')}”.`
      : '';
  const asked = sentence(askedCore) + expect;

  let agent: string;
  if (!inputs.finalAnswer && inputs.stepCount === 0) {
    agent = sentence(`${inputs.agentName} produced no output`);
  } else {
    const tools = inputs.toolsUsed.length
      ? ` used ${inputs.toolsUsed.length === 1 ? 'the tool' : 'tools'} ${inputs.toolsUsed.slice(0, 4).join(', ')}${inputs.toolsUsed.length > 4 ? ` (+${inputs.toolsUsed.length - 4} more)` : ''} and`
      : '';
    const steps = `${inputs.stepCount} recorded step${inputs.stepCount === 1 ? '' : 's'}`;
    const answer = inputs.finalAnswer
      ? ` answered: “${truncateForSummary(inputs.finalAnswer, 260)}”`
      : inputs.notJudged?.stage === 'pending'
        ? ` has ${steps} and no final response yet`
        : ` has ${steps} and no final text response`;
    agent = sentence(`${inputs.agentName}${tools}${answer}`);
  }

  const judgedByChecksOnly = !inputs.reasoning && summarizeChecks(report.matcherResults).total > 0;
  const why = reason && reason.trim() ? reason : verdictReason(inputs, report);
  const verdict = composeVerdict(inputs, why, judgedByChecksOnly);
  return { asked, agent, verdict };
}

/** True when there is a pass/fail verdict whose reason a model could word — unjudged runs need no model. */
export function hasVerdictToExplain(report: Parameters<typeof classifyVerdict>[0]): boolean {
  return classifyVerdict(report).verdict !== 'not_judged';
}
