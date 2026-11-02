/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Plain-language reading of a report's checks (matcher results) for the
 * Judge Evaluation tab.
 *
 * Code-SDK tests record each `expect(...)` as a MatcherResult whose
 * `description` is the chai-style assertion text ("false to equal true") and
 * whose `errorMessage` is whatever the test author wrote, conventionally:
 *
 *   "<what was checked>: k=v (bar ≤ N), k=v (need ≥ N), … (request X, mode Y): expected false to equal true"
 *
 * The assertion text alone is unreadable ("false to equal true"); the
 * author's message is the real title and the `k=v (limit)` pairs are the real
 * evidence. This module parses that convention — defensively, anything it
 * cannot read is left as plain text — so the UI can show a title, a
 * measured-vs-limit table and a one-line verdict headline instead of the raw
 * strings. The raw strings stay available (collapsed) in the UI.
 */

import type { MatcherResult } from '@/lib/matchers/types';

export interface Measurement {
  key: string;
  value: string;
  /** Comparison operator when the message stated a limit (`≤`, `≥`, `<`, `>`, `=`). */
  op?: string;
  limit?: string;
  /** Whether the measured value satisfies the limit; undefined when no limit / not numeric. */
  ok?: boolean;
  /** `value / limit` when the limit was breached and both are numeric (e.g. 5.7 → "5.7× over"). */
  ratio?: number;
}

export interface ParsedAssertion {
  /** The author's "what was checked" label (text before the first `: `), or ''. */
  label: string;
  /** The message body after the label and before the context, when it is not just `k=v` pairs. */
  rest: string;
  measurements: Measurement[];
  /** Trailing "(request …, mode …)" style context, without parentheses. */
  context?: string;
  /** The chai clause ("false to equal true"), when present. */
  expected?: string;
  /**
   * True only when the message had a "label:" prefix or at least one `k=v`
   * pair — i.e. the author wrote something this parser understands. Callers
   * must not hide the raw text when this is false.
   */
  structured: boolean;
}

const LIMIT_WORDS = /^(?:bar|need|needs|limit|max|min|expected|threshold|target|at least|at most)\s*([≤≥<>=]=?)\s*(.+)$/i;
/** A number as the author would write it: 339809, 339,809, 92.3 — optionally followed by a unit. */
const VALUE_RE = /^([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s?(ms|s|sec|secs|min|mins|h|%|chars|tokens|docs|documents|items|spans|KB|MB|GB))?$/;
/** Messages longer than this are shown raw — the parser is for one-line author messages, not dumps. */
export const MAX_PARSED_MESSAGE_CHARS = 2_000;

export function toNumber(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/^\s*([-+]?\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
}

export function compare(value: number, op: string, limit: number): boolean {
  switch (op) {
    case '≤': case '<=': return value <= limit;
    case '<': return value < limit;
    case '≥': case '>=': return value >= limit;
    case '>': return value > limit;
    case '=': case '==': return value === limit;
    default: return value <= limit;
  }
}

function splitValue(raw: string): { num?: number; unit?: string } {
  const m = raw.trim().match(VALUE_RE);
  if (!m) return {};
  return { num: toNumber(m[1]), unit: m[2] ? m[2].toLowerCase() : undefined };
}

/**
 * Parse one assertion message. Never throws; an unrecognised or oversized
 * message comes back unstructured (`structured: false`, no label) so callers
 * show the raw text. Linear: the message is split on `,`/`;` and each segment
 * is matched once — no backtracking across the whole string.
 */
export function parseAssertionMessage(message: string | undefined | null): ParsedAssertion {
  const empty: ParsedAssertion = { label: '', rest: '', measurements: [], structured: false };
  if (!message || typeof message !== 'string' || message.length > MAX_PARSED_MESSAGE_CHARS) return empty;
  let text = message.trim();
  let expected: string | undefined;
  // chai's trailer is the LAST ": expected …" — author prose may contain the word.
  const trailer = text.lastIndexOf(': expected ');
  if (trailer > 0) {
    expected = text.slice(trailer + 2).replace(/^expected\s+/, '').trim();
    text = text.slice(0, trailer).trim();
  }
  let label = '';
  let hadLabel = false;
  const colon = text.indexOf(': ');
  if (colon > 0 && !text.slice(0, colon).includes('=')) {
    label = text.slice(0, colon).trim();
    text = text.slice(colon + 2);
    hadLabel = true;
  }
  let context: string | undefined;
  const ctx = text.match(/\(((?:request|requestId|run|trace|session)\b[^()]*)\)\s*$/i);
  if (ctx) {
    context = ctx[1];
    text = text.slice(0, ctx.index).trim().replace(/[,;]\s*$/, '');
  }
  const measurements: Measurement[] = [];
  const leftovers: string[] = [];
  // Segments: "k=v", "k=v (bar ≤ N)", or free prose. Parentheses inside a
  // segment are kept together by splitting only on delimiters outside them.
  for (const seg of splitTopLevel(text)) {
    const m = seg.match(/^\s*([A-Za-z_][\w .\-/@]{0,60}?)\s*=\s*([^()]+?)\s*(?:\(([^()]*)\))?\s*$/);
    if (!m) { if (seg.trim()) leftovers.push(seg.trim()); continue; }
    const key = m[1].trim();
    const value = m[2].trim();
    const meas: Measurement = { key, value };
    const lim = m[3] ? m[3].trim().match(LIMIT_WORDS) : null;
    if (lim) {
      meas.op = lim[1];
      meas.limit = lim[2].trim();
      const v = splitValue(value);
      const l = splitValue(meas.limit);
      // Compare only like with like: same unit (or both unitless). "500ms ≤ 1s"
      // is left uncompared rather than guessed.
      if (v.num !== undefined && l.num !== undefined && (v.unit ?? '') === (l.unit ?? '')) {
        meas.ok = compare(v.num, meas.op, l.num);
        if (!meas.ok && l.num !== 0) meas.ratio = v.num / l.num;
      }
    } else if (m[3]) {
      // A parenthetical that is not a limit stays with the value ("documents=5 (unique)").
      meas.value = `${value} (${m[3].trim()})`;
    }
    measurements.push(meas);
  }
  const rest = leftovers.join(', ');
  const structured = hadLabel || measurements.length > 0;
  // Narrative with at least one k=v but no "label:" — the prose IS the label
  // ("answer present with retrieval omitted; service chose SIMPLE, documents=0").
  if (!hadLabel && structured && rest) { label = rest; }
  return { label, rest: hadLabel ? rest : (structured ? '' : text), measurements, context, expected, structured };
}

/** Split on `,` / `;` that are not inside parentheses or brackets. Linear. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0; let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The runner's synthetic "later matchers never ran" marker (services/evaluation appendNotReachedMarker). */
export function isNotReachedMarker(m: Pick<MatcherResult, 'notReached' | 'description'>): boolean {
  return !!m.notReached || /^Test body did not complete/.test(m.description || '');
}

/**
 * Human title for a check row: the author's label when the message has one,
 * else the assertion text. The not-reached marker gets a short fixed title.
 */
export function checkTitle(m: Pick<MatcherResult, 'description' | 'errorMessage' | 'notReached'>): string {
  if (isNotReachedMarker(m)) return 'Later checks did not run';
  const parsed = parseAssertionMessage(m.errorMessage);
  return (parsed.structured && parsed.label) || m.description || '(check)';
}

/**
 * One-line evidence for a FAILED check: the breached measurements
 * ("totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s"), else the
 * author's free text after the label. Never lists passing measurements as
 * the reason for a failure; '' when there is nothing structured to say.
 */
export function checkEvidence(m: Pick<MatcherResult, 'errorMessage' | 'description' | 'notReached' | 'reasoning'>): string {
  if (isNotReachedMarker(m)) return '';
  const parsed = parseAssertionMessage(m.errorMessage);
  // Unstructured message (deterministic evaluator prose, a plain throw): its
  // first sentence is the evidence; the row still shows the full raw text.
  if (!parsed.structured) return firstSentence(m.reasoning || m.errorMessage, 200);
  const bad = parsed.measurements.filter(x => x.ok === false);
  if (bad.length) return bad.map(x => `${x.key} ${formatNumber(x.value)} vs ${x.op} ${formatNumber(x.limit!)}`).join(' · ');
  // No breached limit: show the plain facts the author recorded (measurements
  // without a limit, e.g. "documents 0") and any free text — never the
  // measurements that PASSED their limit.
  const facts = parsed.measurements.filter(x => x.ok === undefined && !x.limit).map(x => `${x.key} ${formatNumber(x.value)}`);
  const out = [...facts, parsed.rest].filter(Boolean).join(' · ');
  return out.length > 200 ? `${out.slice(0, 199)}…` : out;
}

export function formatNumber(s: string): string {
  const v = splitValue(s);
  if (v.num === undefined) return s;
  const num = Number.isInteger(v.num) ? v.num.toLocaleString('en-US') : String(v.num);
  return v.unit ? `${num} ${v.unit}` : num;
}

export function formatRatio(r: number | undefined): string {
  if (r === undefined || !Number.isFinite(r)) return '';
  if (r >= 1) return `${r >= 10 ? Math.round(r) : r.toFixed(1)}× over`;
  return `${Math.round((1 - r) * 100)}% short`;
}

export interface ChecksSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  notReached: number;
  notApplicable: number;
  llmJudgeCalls: number;
}

export function summarizeChecks(results: MatcherResult[] | undefined): ChecksSummary {
  const list = Array.isArray(results) ? results : [];
  const s: ChecksSummary = { total: 0, passed: 0, failed: 0, errored: 0, notReached: 0, notApplicable: 0, llmJudgeCalls: 0 };
  for (const m of list) {
    if (isNotReachedMarker(m)) { s.notReached++; continue; }
    if (m.notApplicable) { s.notApplicable++; continue; }
    s.total++;
    if (m.method === 'llm-judge') s.llmJudgeCalls++;
    if (m.errored) s.errored++;
    else if (m.pass) s.passed++;
    else s.failed++;
  }
  return s;
}

/** Collapse a judge's prose into its first sentence (markdown stripped). */
export function firstSentence(text: string | undefined, max = 200): string {
  const t = String(text || '').replace(/[*#`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^(.{20,}?[.!?])(\s|$)/);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface JudgementHeadline {
  tone: 'passed' | 'failed' | 'errored' | 'pending';
  /** e.g. "FAILED — cost/latency within the fix bar: totalTokens 339,809 vs ≤ 60,000 · time 92.3 s vs ≤ 30 s" */
  title: string;
  /** e.g. "Decided by 2 code checks written in the test (no LLM judge): 1 passed, 1 failed, 1 not reached." */
  how: string;
}

/**
 * The one line a reader needs: the verdict and what decided it. Built only
 * from the report's own fields (never from a model).
 */
export function buildJudgementHeadline(report: {
  passFailStatus?: string | null;
  metricsStatus?: string;
  failureStage?: string;
  matcherResults?: MatcherResult[];
  llmJudgeReasoning?: string;
  judgeProvider?: string;
  error?: string;
}): JudgementHeadline {
  const s = summarizeChecks(report.matcherResults);
  const errored = report.metricsStatus === 'error' || report.failureStage === 'agent' || report.failureStage === 'judge' || report.failureStage === 'trace';
  if (errored) {
    const stage = report.failureStage === 'agent' ? 'the agent request failed' : report.failureStage === 'trace' ? 'traces could not be collected' : 'the judge could not produce a verdict';
    return { tone: 'errored', title: `Not judged — ${stage}`, how: report.error ? firstSentence(report.error, 240) : 'No checks ran, so no metrics were recorded (not zeros).' };
  }
  if (report.passFailStatus !== 'passed' && report.passFailStatus !== 'failed') {
    return { tone: 'pending', title: 'No verdict yet', how: 'The judgement has not completed for this report.' };
  }
  const passed = report.passFailStatus === 'passed';
  const noLlm = s.llmJudgeCalls === 0 && (report.judgeProvider === 'none' || !report.llmJudgeReasoning);
  const parts: string[] = [];
  if (s.total) {
    parts.push(`${s.passed} passed`);
    if (s.failed) parts.push(`${s.failed} failed`);
    if (s.errored) parts.push(`${s.errored} could not be evaluated`);
    if (s.notReached) parts.push(`${s.notReached} not reached`);
    if (s.notApplicable) parts.push(`${s.notApplicable} n/a`);
  }
  const decided = s.total - s.errored; // errored checks produced no verdict
  const judgeKind = s.total === 0
    ? (noLlm ? 'No checks were recorded.' : 'Decided by the LLM judge.')
    : noLlm
      ? `Decided by ${decided} code check${decided === 1 ? '' : 's'} written in the test (no LLM judge): ${parts.join(', ')}.`
      : s.llmJudgeCalls === s.total
        ? `Decided by the LLM judge (${s.total} judge call${s.total === 1 ? '' : 's'}): ${parts.join(', ')}.`
        : `Decided by ${decided} checks — ${decided - s.llmJudgeCalls} deterministic + ${s.llmJudgeCalls} LLM judge: ${parts.join(', ')}.`;

  if (passed) {
    // Say what the checks actually show, even when the verdict disagrees
    // with them (a policy may pass a case with a failed "observe" check).
    const unanimous = s.failed === 0 && s.errored === 0;
    const title = !s.total
      ? 'PASSED'
      : unanimous
        ? `PASSED — all ${s.total} check${s.total === 1 ? '' : 's'} passed`
        : `PASSED — ${s.passed} of ${s.total} checks passed${s.failed ? `, ${s.failed} failed` : ''}${s.errored ? `, ${s.errored} could not be evaluated` : ''}`;
    return { tone: 'passed', title, how: judgeKind };
  }
  // Failed: name the failing checks with their evidence. Errored checks
  // decided nothing and are counted in `how`, not blamed here.
  const failing = (report.matcherResults || []).filter(m => !isNotReachedMarker(m) && !m.notApplicable && !m.pass && !m.errored);
  const bits = failing.slice(0, 2).map(m => {
    if (m.method === 'llm-judge') {
      // Prefer the judge's own Summary/Verdict section when its prose has
      // headings; otherwise its first sentence.
      const sections = splitReasoningSections(m.reasoning);
      const pick = sections.find(sec => /summary|verdict|conclusion/i.test(sec.title)) || sections[0];
      const body = (pick?.body || m.errorMessage || '').replace(/^\s*(?:\*\*[^*\n]+\*\*:?|#{1,4}\s[^\n]+)\s*/, '');
      const why = firstSentence(body, 160);
      return why ? `judge: ${why.replace(/\.$/, '')}` : 'LLM judge failed it';
    }
    const title = checkTitle(m);
    const ev = checkEvidence(m);
    const shortEv = ev.length > 120 ? `${ev.slice(0, 119)}…` : ev;
    return shortEv ? `${title.replace(/\.$/, '')}: ${shortEv}` : title;
  });
  const more = failing.length > 2 ? ` (+${failing.length - 2} more)` : '';
  let why = bits.length ? bits.join(' · ') + more : '';
  if (!why) {
    // No failed check row at all: the test body itself threw (the runner's
    // not-reached marker carries the exception), or an LLM judge wrote prose.
    const marker = (report.matcherResults || []).find(m => isNotReachedMarker(m) && m.errorMessage);
    why = marker?.errorMessage
      ? `the test threw before any check could fail: ${firstSentence(marker.errorMessage, 160).replace(/\.$/, '')}`
      : firstSentence(report.llmJudgeReasoning, 200) || 'see the checks below';
  }
  return { tone: 'failed', title: `FAILED — ${why}`, how: judgeKind };
}

/**
 * Split judge prose into sections by bold heading lines
 * ("**Fact Precision Analysis:**") so long reasoning reads as a table of
 * contents. Text with fewer than two headings is returned as one section.
 */
export function splitReasoningSections(text: string | undefined): Array<{ title: string; body: string }> {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out: Array<{ title: string; body: string[] }> = [];
  let cur = { title: '', body: [] as string[] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const m = inFence ? null : line.match(/^\s*(?:#{1,4}\s+(.+?)\s*:?\s*|\*\*(.+?):?\*\*:?\s*)$/);
    if (m) {
      if (cur.body.join('').trim() || cur.title) out.push(cur);
      cur = { title: (m[1] || m[2]).trim().replace(/\s+Analysis$/i, ''), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.body.join('').trim() || cur.title) out.push(cur);
  const sections = out.map(s => ({ title: s.title, body: s.body.join('\n').trim() })).filter(s => s.body || s.title);
  if (sections.filter(s => s.title).length < 2) return [{ title: '', body: String(text || '').trim() }];
  return sections;
}
