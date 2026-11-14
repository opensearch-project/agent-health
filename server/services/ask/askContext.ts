/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Context for a "highlight & ask" question: what the user is looking at
 * (route → ids), the text they selected, and a compact data snapshot loaded
 * from storage so the answering agent is grounded before it calls any tool.
 *
 * The SPA is PATH-routed (BrowserRouter). Every link this module emits is a
 * path (`/evaluations/benchmarks/<b>/runs/<r>/inspect?reportId=<id>`), never
 * a hash route — the legacy assistant prompt still says `/#/compare/...`,
 * which produces dead links.
 */

import type { IStorageModule } from '@/server/adapters/types';
import type { TrajectoryStep } from '@/types';

// ============================================================================
// Request shapes (shared with the client, see services/client/askApi.ts)
// ============================================================================

export interface AskSelection {
  /** The highlighted text. */
  text: string;
  /** A little surrounding text (same element) so the agent can place the quote. */
  nearbyText?: string;
}

export interface AskPageContext {
  /** Path + query of the page the question was asked from, e.g. `/compare/bench-1?runs=a,b`. */
  route: string;
  /** Ids the client already knows (win over ids parsed from the route). */
  params?: Partial<AskRefs>;
  /** Document title or page heading. */
  title?: string;
}

/** Everything we can name on a page. */
export interface AskRefs {
  benchmarkId?: string;
  /** Evaluation run (benchmark execution) id — `eval-run-…` / `run-…`. */
  runId?: string;
  /** Per-test-case report id — `report-…`. */
  reportId?: string;
  testCaseId?: string;
  traceId?: string;
  /** Runs compared on `/compare/:benchmarkId?runs=a,b`. */
  comparisonRunIds?: string[];
}

// ============================================================================
// Route → refs
// ============================================================================

/**
 * Parse the ids a route carries. Pure; unit-tested. Handles every id-bearing
 * route in App.tsx:
 *   /evaluations/benchmarks/:b/runs/:r/inspect?reportId=…   (run inspector)
 *   /evaluations/benchmarks/:b/cases/:caseId
 *   /evaluations/benchmarks/:b(/runs)
 *   /evaluations/runs/:r(/inspect)
 *   /evaluations/test-cases/:tc      /test-cases/:tc/runs
 *   /benchmarks/:b/runs/:r           (legacy: :r is a REPORT id)
 *   /runs/:reportId                  (legacy run details)
 *   /compare/:b?runs=a,b
 *   /agent-traces?traceId=…
 */
export function deriveAskRefs(route: string): AskRefs {
  const [pathname, search = ''] = route.split('?');
  const parts = pathname.split('/').filter(Boolean);
  const q = new URLSearchParams(search);
  const refs: AskRefs = {};

  const after = (segment: string, offset = 1): string | undefined => {
    const i = parts.indexOf(segment);
    return i >= 0 && i + offset < parts.length ? decodeURIComponent(parts[i + offset]) : undefined;
  };

  if (parts[0] === 'evaluations') {
    if (parts[1] === 'benchmarks') {
      refs.benchmarkId = after('benchmarks');
      if (parts.includes('runs')) refs.runId = after('runs');
      if (parts.includes('cases')) refs.testCaseId = after('cases');
    } else if (parts[1] === 'runs') {
      const id = after('runs');
      if (id && id !== 'new') refs.runId = id;
    } else if (parts[1] === 'test-cases') {
      refs.testCaseId = after('test-cases');
    }
  } else if (parts[0] === 'compare') {
    refs.benchmarkId = after('compare');
    const runs = (q.get('runs') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (runs.length) refs.comparisonRunIds = runs;
  } else if (parts[0] === 'benchmarks') {
    refs.benchmarkId = after('benchmarks');
    // Legacy /benchmarks/:b/runs/:reportId renders RunDetailsPage for a REPORT.
    if (parts.includes('runs')) refs.reportId = after('runs');
  } else if (parts[0] === 'runs') {
    refs.reportId = after('runs');
  } else if (parts[0] === 'test-cases') {
    refs.testCaseId = after('test-cases');
  }

  const reportId = q.get('reportId');
  if (reportId) refs.reportId = reportId;
  const traceId = q.get('traceId');
  if (traceId) refs.traceId = traceId;
  const tc = q.get('testCaseId');
  if (tc) refs.testCaseId = tc;

  // Drop empty strings so callers can rely on `undefined`.
  for (const k of Object.keys(refs) as Array<keyof AskRefs>) {
    const v = refs[k];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete refs[k];
  }
  return refs;
}

/** Route-derived refs merged with what the client already knows (client wins). */
export function resolveAskRefs(page: AskPageContext): AskRefs {
  const fromRoute = deriveAskRefs(page.route || '/');
  const fromClient = Object.fromEntries(
    Object.entries(page.params ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ) as Partial<AskRefs>;
  return { ...fromRoute, ...fromClient };
}

// ============================================================================
// PATH-routed links
// ============================================================================

export const askLinks = {
  benchmark: (benchmarkId: string) => `/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}`,
  run: (benchmarkId: string | undefined, runId: string) =>
    benchmarkId
      ? `/evaluations/benchmarks/${encodeURIComponent(benchmarkId)}/runs/${encodeURIComponent(runId)}/inspect`
      : `/evaluations/runs/${encodeURIComponent(runId)}/inspect`,
  report: (benchmarkId: string | undefined, runId: string | undefined, reportId: string) =>
    runId
      ? `${askLinks.run(benchmarkId, runId)}?reportId=${encodeURIComponent(reportId)}`
      : `/runs/${encodeURIComponent(reportId)}`,
  testCase: (testCaseId: string) => `/evaluations/test-cases/${encodeURIComponent(testCaseId)}`,
  compare: (benchmarkId: string, runIds: string[]) =>
    `/compare/${encodeURIComponent(benchmarkId)}?runs=${runIds.map(encodeURIComponent).join(',')}`,
};

// ============================================================================
// Snapshot
// ============================================================================

const SECTION_CHAR_CAP = 9_000;
const TRAJECTORY_STEPS_MAX = 40;
const COMPARE_RUNS_MAX = 6;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)` : s;
}

function json(obj: unknown, cap = SECTION_CHAR_CAP): string {
  return '```json\n' + truncate(JSON.stringify(obj, null, 1), cap) + '\n```';
}

function slimStep(step: TrajectoryStep, i: number) {
  const s: any = step;
  return {
    i,
    type: s.type,
    toolName: s.toolName,
    content: typeof s.content === 'string' ? s.content.slice(0, 600) : undefined,
    toolArgs: s.toolArgs !== undefined ? JSON.stringify(s.toolArgs).slice(0, 400) : undefined,
    toolOutput: typeof s.toolOutput === 'string' ? s.toolOutput.slice(0, 400) : s.toolOutput !== undefined ? JSON.stringify(s.toolOutput).slice(0, 400) : undefined,
  };
}

function slimReport(r: any) {
  const traj: TrajectoryStep[] = Array.isArray(r.trajectory) ? r.trajectory : [];
  // Whole trajectory when it fits; otherwise the tail (how the run ended).
  const tail = traj.slice(-TRAJECTORY_STEPS_MAX);
  const offset = traj.length - tail.length;
  return {
    id: r.id,
    testCaseId: r.testCaseId,
    agentKey: r.agentKey,
    agentName: r.agentName,
    modelId: r.modelId,
    status: r.status,
    passFailStatus: r.passFailStatus,
    metricsStatus: r.metricsStatus,
    metrics: r.metrics,
    judgeModel: r.judgeModel ?? r.judgeModelId,
    judgeMode: r.judgeMode,
    llmJudgeReasoning: r.llmJudgeReasoning,
    improvementStrategies: r.improvementStrategies,
    matcherResults: r.matcherResults,
    performanceMetrics: r.performanceMetrics,
    traceId: r.traceId,
    sessionId: r.sessionId,
    runId: r.runId,
    experimentRunId: r.experimentRunId,
    experimentId: r.experimentId,
    trajectoryTotalSteps: traj.length,
    trajectoryIncluded: offset === 0 ? 'complete' : `last ${tail.length} of ${traj.length} steps`,
    trajectory: tail.map((s, i) => slimStep(s, offset + i)),
  };
}

export interface AskSnapshot {
  /** Markdown the agent reads. Empty when the page names nothing. */
  markdown: string;
  /** Refs after following links (a report fills in its run / test case). */
  refs: AskRefs;
  /** Which entities were loaded (for the UI "looked at" caption). */
  loaded: string[];
}

/**
 * Load a compact snapshot of everything the page names. Never throws — a
 * failing lookup becomes a one-line note so the agent knows what it did not
 * see and can fetch it with a tool.
 */
export async function buildAskSnapshot(storage: IStorageModule, refsIn: AskRefs): Promise<AskSnapshot> {
  const refs: AskRefs = { ...refsIn };
  const sections: string[] = [];
  const loaded: string[] = [];

  // --- Report (per-test-case result) -------------------------------------
  if (refs.reportId) {
    try {
      const report = await storage.runs.getById(refs.reportId);
      if (report) {
        loaded.push(`report ${report.id}`);
        if (!refs.testCaseId && report.testCaseId) refs.testCaseId = report.testCaseId;
        if (!refs.runId && (report as any).experimentRunId) refs.runId = (report as any).experimentRunId;
        if (!refs.benchmarkId && (report as any).experimentId) refs.benchmarkId = (report as any).experimentId;
        if (!refs.traceId && (report as any).traceId) refs.traceId = (report as any).traceId;
        sections.push(
          `### Report ${report.id} (${report.passFailStatus ?? report.status})\n` +
            `Link: ${askLinks.report(refs.benchmarkId, refs.runId, report.id)}\n` +
            json(slimReport(report), SECTION_CHAR_CAP * 2)
        );
      } else {
        sections.push(`### Report ${refs.reportId}\n_Not found in storage._`);
      }
    } catch (err: any) {
      sections.push(`### Report ${refs.reportId}\n_Failed to load: ${err?.message ?? err}_`);
    }
  }

  // --- Evaluation run (benchmark execution) ---------------------------------
  if (refs.runId) {
    try {
      const run = await storage.evaluationRuns.getById(refs.runId);
      if (run) {
        loaded.push(`run ${run.id}`);
        if (!refs.benchmarkId && run.benchmarkId) refs.benchmarkId = run.benchmarkId;
        const names = new Map((run.testCaseSnapshots ?? []).map((s) => [s.id, s.name]));
        // Compact per-case table: name + verdict. Report ids only for the
        // non-passing cases (the ones a question is likely about); the rest
        // are reachable via get_evaluation_run(runId).results.
        const entries = Object.entries(run.results ?? {});
        const verdict = (r: any) => String(r.passFailStatus ?? r.status);
        const results = entries.map(([tcId, r]) => `${names.get(tcId) ?? tcId}: ${verdict(r)}`);
        const notPassed = entries
          .filter(([, r]) => verdict(r) !== 'passed')
          .slice(0, 25)
          .map(([tcId, r]) => ({ testCase: names.get(tcId) ?? tcId, testCaseId: tcId, status: verdict(r), reportId: r.reportId, error: r.error }));
        const runLink = askLinks.run(refs.benchmarkId ?? run.benchmarkId, run.id);
        sections.push(
          `### Run ${run.id} — "${run.name}" (${run.status})\n` +
            `Link: ${runLink} — a case's report opens at ${runLink}?reportId=<reportId>\n` +
            json({
              id: run.id,
              name: run.name,
              description: run.description,
              status: run.status,
              agentKey: run.agentKey,
              modelId: run.modelId,
              judgeModelId: run.judgeModelId,
              judgeProvider: run.judgeProvider,
              evaluatorId: run.evaluatorId,
              createdAt: run.createdAt,
              completedAt: run.completedAt,
              stats: run.stats,
              judgeFailureSummary: run.judgeFailureSummary,
              benchmarkId: run.benchmarkId,
              resultsByCase: results,
              notPassed,
            }, 6_000)
        );
      } else {
        sections.push(`### Run ${refs.runId}\n_Not found as an evaluation run (it may be a legacy benchmark run id)._`);
      }
    } catch (err: any) {
      sections.push(`### Run ${refs.runId}\n_Failed to load: ${err?.message ?? err}_`);
    }
  }

  // --- Comparison ----------------------------------------------------------
  if (refs.comparisonRunIds?.length) {
    const ids = refs.comparisonRunIds.slice(0, COMPARE_RUNS_MAX);
    const perRun: Array<{ id: string; name?: string; agentKey?: string; stats?: unknown; byCase: Record<string, string>; reportIds: Record<string, string> }> = [];
    const missing: string[] = [];
    const caseNames = new Map<string, string>();
    for (const id of ids) {
      try {
        const run = await storage.evaluationRuns.getById(id);
        if (!run) {
          // Legacy benchmark run (embedded in benchmark.runs[]): fall back to its reports.
          const reports = refs.benchmarkId ? await storage.runs.getByExperimentRun(refs.benchmarkId, id, 500) : [];
          if (!reports.length) { missing.push(id); continue; }
          const byCase: Record<string, string> = {};
          const reportIds: Record<string, string> = {};
          for (const r of reports) { byCase[r.testCaseId] = String(r.passFailStatus ?? r.status); reportIds[r.testCaseId] = r.id; }
          perRun.push({ id, byCase, reportIds });
          loaded.push(`run ${id} (${reports.length} reports)`);
          continue;
        }
        for (const s of run.testCaseSnapshots ?? []) caseNames.set(s.id, s.name);
        const byCase: Record<string, string> = {};
        const reportIds: Record<string, string> = {};
        for (const [tcId, r] of Object.entries(run.results ?? {})) { byCase[tcId] = String((r as any).passFailStatus ?? r.status); if (r.reportId) reportIds[tcId] = r.reportId; }
        perRun.push({ id, name: run.name, agentKey: run.agentKey, stats: run.stats, byCase, reportIds });
        loaded.push(`run ${id}`);
      } catch (err: any) {
        missing.push(`${id} (${err?.message ?? err})`);
      }
    }
    if (perRun.length) {
      const allCases = Array.from(new Set(perRun.flatMap((r) => Object.keys(r.byCase))));
      const header = `| test case | ${perRun.map((r) => r.name ?? r.id).join(' | ')} |`;
      const sep = `|---|${perRun.map(() => '---').join('|')}|`;
      const rows = allCases.map(
        (tc) => `| ${caseNames.get(tc) ?? tc} (${tc}) | ${perRun.map((r) => r.byCase[tc] ?? '—').join(' | ')} |`
      );
      const regressions = allCases.filter((tc) => {
        const first = perRun[0].byCase[tc];
        return first === 'passed' && perRun.slice(1).some((r) => r.byCase[tc] === 'failed');
      });
      const improvements = allCases.filter((tc) => {
        const first = perRun[0].byCase[tc];
        return first === 'failed' && perRun.slice(1).some((r) => r.byCase[tc] === 'passed');
      });
      const changed = allCases.filter((tc) => perRun.some((r) => r.byCase[tc] !== perRun[0].byCase[tc]));
      sections.push(
        `### Comparison (${perRun.length} of ${refs.comparisonRunIds.length} runs)\n` +
          (refs.benchmarkId ? `Link: ${askLinks.compare(refs.benchmarkId, ids)}\n` : '') +
          `Runs (left = first in URL = baseline):\n` +
          perRun.map((r) => `- ${r.name ?? r.id} — id ${r.id}, agent ${r.agentKey ?? '?'}, stats ${JSON.stringify(r.stats ?? {})}`).join('\n') +
          `\n\nPer-case verdicts:\n${[header, sep, ...rows].join('\n')}\n\n` +
          `Deterministic facts: regressed (passed in baseline, failed in a later run): ${regressions.length ? regressions.map((tc) => caseNames.get(tc) ?? tc).join(', ') : 'none'}; ` +
          `improved: ${improvements.length ? improvements.map((tc) => caseNames.get(tc) ?? tc).join(', ') : 'none'}.\n` +
          (changed.length
            ? `Report ids for the changed cases (use get_report to read the judge reasoning / trajectory):\n` +
              changed.map((tc) => `- ${caseNames.get(tc) ?? tc}: ${perRun.map((r) => `${r.name ?? r.id} → ${r.reportIds[tc] ?? '—'}`).join('; ')}`).join('\n')
            : `No verdict changed between these runs.`)
      );
    }
    if (missing.length) sections.push(`_Comparison runs not found: ${missing.join(', ')}_`);
    if (refs.comparisonRunIds.length > ids.length) {
      sections.push(`_Only the first ${ids.length} of ${refs.comparisonRunIds.length} compared runs were loaded._`);
    }
  }

  // --- Test case -----------------------------------------------------------
  if (refs.testCaseId) {
    try {
      const tc = await storage.testCases.getById(refs.testCaseId);
      if (tc) {
        loaded.push(`test case ${tc.id}`);
        const latest: any = tc.versions?.[tc.versions.length - 1] ?? {};
        sections.push(
          `### Test case ${tc.id} — "${tc.name}"\nLink: ${askLinks.testCase(tc.id)}\n` +
            json({
              id: tc.id,
              name: tc.name,
              description: tc.description,
              labels: tc.labels,
              currentVersion: tc.currentVersion,
              initialPrompt: latest.initialPrompt ?? (tc as any).initialPrompt,
              expectedOutcomes: latest.expectedOutcomes ?? (tc as any).expectedOutcomes,
              expectedTrajectory: latest.expectedTrajectory,
              context: latest.context ?? (tc as any).context,
            })
        );
      } else {
        sections.push(`### Test case ${refs.testCaseId}\n_Not found in storage._`);
      }
    } catch (err: any) {
      sections.push(`### Test case ${refs.testCaseId}\n_Failed to load: ${err?.message ?? err}_`);
    }
  }

  // --- Benchmark -----------------------------------------------------------
  if (refs.benchmarkId) {
    try {
      const b = await storage.benchmarks.getById(refs.benchmarkId);
      if (b) {
        loaded.push(`benchmark ${b.id}`);
        const runs = (b.runs ?? []).slice(-8).map((r: any) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt,
          status: r.status,
          agentKey: r.agentKey,
          stats: r.stats,
          link: askLinks.run(b.id, r.id),
        }));
        sections.push(
          `### Benchmark ${b.id} — "${b.name}"\nLink: ${askLinks.benchmark(b.id)}\n` +
            json({
              id: b.id,
              name: b.name,
              description: b.description,
              testCaseCount: b.testCaseIds?.length ?? 0,
              totalRuns: b.runs?.length ?? 0,
              recentRuns: runs,
            }, 3_000)
        );
      }
    } catch (err: any) {
      sections.push(`### Benchmark ${refs.benchmarkId}\n_Failed to load: ${err?.message ?? err}_`);
    }
  }

  return {
    markdown: sections.length ? `## Data snapshot (loaded from storage for the current page)\n\n${sections.join('\n\n')}` : '',
    refs,
    loaded,
  };
}

// ============================================================================
// Prompt assembly
// ============================================================================

export interface AskPromptInput {
  question: string;
  selections: AskSelection[];
  page: AskPageContext;
  refs: AskRefs;
  /** Empty for follow-ups on the same page (pi already has the snapshot in context). */
  snapshotMarkdown: string;
  isFollowUp?: boolean;
}

export const ASK_ANSWER_RULES = `Answer rules:
- Answer the question directly in the first sentence, then give the evidence. Be brief (aim for under 200 words unless asked for detail).
- Ground every claim in the snapshot or in data you fetched. Quote judge reasoning / span attributes verbatim when they are the evidence. Never invent ids, numbers or tool names.
- End with a one-line "Looked at:" list naming the entities you used (report / run / test case / spans), each as a Markdown link using PATH routes exactly as given (e.g. /evaluations/benchmarks/<b>/runs/<r>/inspect?reportId=<id>). Never use hash routes (/#/...).
- If the data needed is not in the snapshot and you cannot fetch it, say exactly what is missing — do not ask the user to paste data.`;

export function buildAskSystemPrompt(): string {
  return `You are the Agent Health assistant. Agent Health evaluates AI agents: a benchmark groups test cases; an evaluation run executes an agent on them; each test case produces a report with the agent's trajectory (tool calls + responses), an LLM-judge verdict (passFailStatus, metrics, llmJudgeReasoning) and optionally OpenTelemetry spans (gen_ai.* attributes). The user highlighted text in the web UI and asked a question about it.

You have READ-ONLY tools over this Agent Health server: get_report(reportId), get_evaluation_run(runId), get_test_case(testCaseId), get_benchmark(benchmarkId), query_spans({traceId?, runId?, sessionId?, nameFilter?}). The data snapshot in the first message already contains the page's own report / run / test case / benchmark (a report's trajectory is complete unless marked otherwise) — answer from it directly and do NOT re-fetch those. Questions about a verdict ("why did this fail", "what does this score mean") are answered from the judge reasoning and trajectory in the snapshot WITHOUT any tool call. Call tools only for data the snapshot lacks: another case's report, a run that isn't on the page, or — only when the question is about spans, latency, tokens or what the agent actually executed — query_spans with the report's traceId.

${ASK_ANSWER_RULES}`;
}

export function buildAskUserPrompt(input: AskPromptInput): string {
  const parts: string[] = [];
  parts.push(`## Page\nRoute: ${input.page.route}${input.page.title ? `\nTitle: ${input.page.title}` : ''}`);
  const refEntries = Object.entries(input.refs).filter(([, v]) => v !== undefined);
  if (refEntries.length) {
    parts.push(`Ids on this page: ${refEntries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('; ')}`);
  }
  if (input.selections.length) {
    parts.push(
      `## Highlighted text (${input.selections.length})\n` +
        input.selections
          .map((s, i) => {
            const quote = s.text.trim().split('\n').map((l) => `> ${l}`).join('\n');
            const near = s.nearbyText?.trim() && s.nearbyText.trim() !== s.text.trim()
              ? `\n_Surrounding text:_ ${s.nearbyText.trim().slice(0, 600)}`
              : '';
            return `**Selection ${i + 1}:**\n${quote}${near}`;
          })
          .join('\n\n')
    );
  }
  if (input.snapshotMarkdown) parts.push(input.snapshotMarkdown);
  else if (input.isFollowUp) parts.push('_(Follow-up: the data snapshot from earlier in this conversation still applies.)_');
  parts.push(`## Question\n${input.question.trim()}`);
  return parts.join('\n\n');
}
