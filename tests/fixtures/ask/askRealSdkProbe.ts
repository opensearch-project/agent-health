/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Child-process probe (run via tsx by tests/unit/server/services/ask/askService.realSdk.test.ts).
 *
 * The REAL assistant service (`streamAsk` / `prepareAsk`, file storage in a
 * temp cwd) on the REAL pi SDK and the REAL AWS SDK, talking to a scripted
 * local Bedrock (tests/fixtures/ask/fakeBedrock.ts) and a local "API" server
 * that holds tool lookups. One long-lived process, like the server. Prints ONE
 * JSON line of observations. Env from the Jest side: a temp
 * `AWS_SHARED_CREDENTIALS_FILE` holding profile `rotation-test` = key A.
 *
 *   rotation        turn 1 signed with A → file rotated to B, clock past the TTL →
 *                   the follow-up on the SAME live session signs with B. Baseline
 *                   (what the PR did before): a fresh plain `ModelRuntime.create()`
 *                   after the rotation still signs with A — the AWS SDK caches the
 *                   credentials file for the life of the process.
 *   failedFollowUp  answer → provider HTTP 400 on the follow-up → the turn is an
 *                   error, not the first answer; partial stream then socket drop → error.
 *   toolAbort       model asks for a lookup the API never answers → client disconnect →
 *                   the lookup is torn down, prompt() settles, the slot is free (bounded).
 *   toolBudget      model loops on lookups → cut off after AH_ASK_MAX_TOOL_CALLS, slot free.
 *   readOnly        model asks for `bash` / `write` → refused by pi (not in the tool
 *                   allowlist), no file touched; the model was offered exactly ASK_TOOLS.
 *   exclusivity     three questions at once on one held session → one runs, two refused,
 *                   the hold survives the refusals; cold resume after a reset: two
 *                   concurrent follow-ups → one pi session (one new user message).
 */

import * as http from 'http';
import type { AddressInfo } from 'net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startFakeBedrock, type BedrockRequest } from './fakeBedrock';
import { ROTATION_PROFILE, writeStaticProfile } from '../aws/rotationProfile';

const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE!;

// Deterministic clock for the refreshing provider's TTL (installed before any import that reads Date.now).
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;

interface Outcome { answer?: string; error?: string; deltas: string[]; tools: string[]; meta?: any }

async function main(): Promise<void> {
  const fake = await startFakeBedrock();
  const held: Array<{ closed: boolean }> = [];
  let apiHits = 0;
  const api = http.createServer((req, res) => {
    apiHits += 1;
    if (req.url?.includes('/held')) { const h = { closed: false }; req.on('close', () => { h.closed = true; }); held.push(h); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ run: { id: 'ok', passFailStatus: 'passed' } }));
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));

  const cwd = mkdtempSync(join(tmpdir(), 'ask-realsdk-cwd-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'ask-realsdk-pi-'));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false } }));
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'amazon-bedrock': { baseUrl: fake.url } } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AWS_PROFILE = ROTATION_PROFILE;
  process.env.AWS_BEDROCK_FORCE_HTTP1 = '1';
  process.env.AH_JUDGE_SERVER_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  process.env.AH_ASK_MAX_TOOL_CALLS = '3';
  process.chdir(cwd);

  const out: Record<string, unknown> = {};
  /** Progress on stderr too, so a run that hangs in a later scenario still shows the earlier ones. */
  const report = (key: string, value: unknown) => { out[key] = value; console.error(`[probe] ${key} ${JSON.stringify(value)}`); };
  let pi: any;
  try {
    pi = await import('@earendil-works/pi-coding-agent');
  } catch (err: any) {
    console.log(JSON.stringify({ skipped: `pi SDK not installed: ${err?.message ?? err}` }));
    return;
  }
  const svc = await import('../../../server/services/ask/askService');
  const { DEFAULT_CREDENTIAL_TTL_MS } = await import('../../../lib/aws/refreshingCredentialProvider');
  const { streamAsk, prepareAsk, askInFlight, resetAskServiceState, getAskSessionStore, ASK_TOOLS } = svc;

  const ask = (req: any): { done: Promise<Outcome>; handle: any; outcome: Outcome } => {
    const outcome: Outcome = { deltas: [], tools: [] };
    let handle: any;
    const done = new Promise<Outcome>((resolve) => {
      handle = streamAsk(req, {
        onMeta: (m: any) => { outcome.meta = m; },
        onDelta: (d: string) => outcome.deltas.push(d),
        onTool: (t: any) => outcome.tools.push(`${t.name}:${t.status}`),
        onDone: (r: any) => { outcome.answer = r.answer; resolve(outcome); },
        onError: (e: string) => { outcome.error = e; resolve(outcome); },
      });
    });
    return { done, handle, outcome };
  };
  const until = async (pred: () => boolean, ms = 5000) => { const t0 = realNow(); while (!pred() && realNow() - t0 < ms) await new Promise((r) => setTimeout(r, 5)); return pred(); };
  const page = { route: '/' };

  /** What the PR did before: a plain runtime, re-created from scratch — the AWS SDK default chain. */
  const plainTurn = async (): Promise<string | null> => {
    const rt = await pi.ModelRuntime.create();
    const model = (await rt.getAvailable()).find((m: any) => m.provider === 'amazon-bedrock');
    const loader = new pi.DefaultResourceLoader({ cwd, agentDir, systemPromptOverride: () => 'baseline', appendSystemPromptOverride: () => [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const { session } = await pi.createAgentSession({ model, modelRuntime: rt, resourceLoader: loader, tools: [], sessionManager: pi.SessionManager.inMemory() });
    const before = fake.requests.length;
    await session.prompt('baseline');
    return fake.requests[before]?.accessKeyId ?? null;
  };

  try {
    // ---------------------------------------------------------------- rotation
    fake.script({ kind: 'text', text: 'Answer one.' });
    const plainBefore = await plainTurn();
    const prep = await prepareAsk({ pageContext: page });
    out.model = prep.model;
    const r1 = await ask({ question: 'first', pageContext: page, sessionId: prep.sessionId }).done;
    const askBefore = fake.requests[fake.requests.length - 1];
    writeStaticProfile(credentialsFile, 'B');
    const plainAfterRotation = await plainTurn(); // a NEW runtime, after the rotation
    offsetMs = DEFAULT_CREDENTIAL_TTL_MS + 1;
    const r2 = await ask({ question: 'second', pageContext: page, sessionId: prep.sessionId }).done;
    const askAfter = fake.requests[fake.requests.length - 1];
    report('rotation', {
      plainBefore, plainAfterRotation,
      askBefore: askBefore.accessKeyId, askBeforeToken: askBefore.sessionToken, askBeforeAnswer: r1.answer,
      askAfterRotation: askAfter.accessKeyId, askAfterRotationToken: askAfter.sessionToken, askAfterAnswer: r2.answer,
      sameSession: r2.meta?.sessionId === prep.sessionId && r1.meta?.sessionId === prep.sessionId,
    });

    // ---------------------------------------------------------------- failed follow-up
    fake.script({ kind: 'http400', message: 'synthetic validation failure' });
    const f2 = await ask({ question: 'third', pageContext: page, sessionId: prep.sessionId }).done;
    fake.script({ kind: 'partialThenDrop', text: 'Half an answer ' });
    const f3 = await ask({ question: 'fourth', pageContext: page, sessionId: prep.sessionId }).done;
    const detail = (await getAskSessionStore()).get(prep.sessionId);
    report('failedFollowUp', {
      firstAnswer: r1.answer,
      httpError: { answer: f2.answer, error: f2.error, deltas: f2.deltas },
      dropped: { answer: f3.answer, error: f3.error, deltas: f3.deltas },
      recorded: detail?.turns.map((t) => ({ q: t.question, answer: t.answer, error: t.error })),
    });

    // ---------------------------------------------------------------- tool abort (client disconnect during a held lookup)
    fake.script((req: BedrockRequest) => (req.messages.some((m: any) => m.role === 'user' && m.content?.some((c: any) => c.toolResult)) ? { kind: 'text', text: 'after tool' } : { kind: 'toolUse', name: 'get_report', input: { reportId: 'held' } }));
    const p2 = await prepareAsk({ pageContext: page });
    const a = ask({ question: 'look it up', pageContext: page, sessionId: p2.sessionId });
    const heldSeen = await until(() => held.length === 1);
    const inFlightDuring = askInFlight();
    const t0 = realNow();
    a.handle.abort();
    const freed = await until(() => askInFlight() === 0, 3000);
    const slotFreedMs = realNow() - t0;
    await until(() => held[0]?.closed === true, 1000);
    let settled = false; a.done.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 50));
    report('toolAbort', { heldSeen, inFlightDuring, freed, slotFreedMs, lookupClosed: held[0]?.closed ?? null, settled, tools: a.outcome.tools });
    const reuse = await ask({ question: 'again', pageContext: page, sessionId: p2.sessionId }).done;
    report('toolAbortReuse', { answer: reuse.answer, error: reuse.error });

    // ---------------------------------------------------------------- tool budget (a model that never stops looking things up)
    fake.script({ kind: 'toolUse', name: 'get_report', input: { reportId: 'ok' } });
    const p3 = await prepareAsk({ pageContext: page });
    const requestsBefore = fake.requests.length;
    const hitsBefore = apiHits;
    const b = await ask({ question: 'loop', pageContext: page, sessionId: p3.sessionId }).done;
    report('toolBudget', { error: b.error, answer: b.answer, lookupsDispatched: apiHits - hitsBefore, toolStarts: b.tools.filter((t) => t.endsWith(':start')).length, modelCalls: fake.requests.length - requestsBefore, inFlight: askInFlight() });

    // ---------------------------------------------------------------- tool budget, PARALLEL batch: five calls in ONE model response (pi runs them concurrently)
    fake.script({ kind: 'toolUse', name: 'get_report', input: { reportId: 'ok' }, calls: Array.from({ length: 5 }, (_, i) => ({ name: 'get_report', input: { reportId: `ok-${i}` } })) });
    const p3b = await prepareAsk({ pageContext: page });
    const hitsBefore2 = apiHits;
    const requestsBefore2 = fake.requests.length;
    const bb = await ask({ question: 'batch', pageContext: page, sessionId: p3b.sessionId }).done;
    // what the model got back for the five calls of the first batch
    const batchResults = fake.requests.slice(requestsBefore2 + 1, requestsBefore2 + 2).flatMap((r) => r.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content.filter((c: any) => c.toolResult).map((c: any) => (c.toolResult.content?.map((x: any) => x.text ?? '').join('').includes('budget exhausted') ? 'refused' : 'served'))));
    report('toolBudgetBatch', { error: bb.error, answer: bb.answer, lookupsDispatched: apiHits - hitsBefore2, toolStarts: bb.tools.filter((t) => t.endsWith(':start')).length, batchResults, inFlight: askInFlight() });

    // ---------------------------------------------------------------- read-only enforcement
    const marker = join(cwd, 'should-never-exist.txt');
    let step = 0;
    fake.script(() => {
      step += 1;
      if (step === 1) return { kind: 'toolUse', name: 'bash', input: { command: `touch ${marker}` } };
      if (step === 2) return { kind: 'toolUse', name: 'write', input: { path: marker, content: 'x' } };
      return { kind: 'text', text: 'gave up' };
    });
    const p4 = await prepareAsk({ pageContext: page });
    const firstReq = fake.requests.length;
    const ro = await ask({ question: 'try to write', pageContext: page, sessionId: p4.sessionId }).done;
    const toolResults = fake.requests.slice(firstReq).flatMap((r) => r.messages.filter((m: any) => m.role === 'user').flatMap((m: any) => m.content.filter((c: any) => c.toolResult).map((c: any) => ({ status: c.toolResult.status, text: c.toolResult.content?.map((x: any) => x.text ?? '').join('') }))));
    report('readOnly', { offered: fake.requests[firstReq].toolNames, expected: [...ASK_TOOLS], toolResults, markerExists: existsSync(marker), answer: ro.answer, error: ro.error, tools: ro.tools });

    // ---------------------------------------------------------------- exclusivity: three at once on one held session
    fake.script({ kind: 'hold' });
    const p5 = await prepareAsk({ pageContext: page });
    const trio = [1, 2, 3].map((i) => ask({ question: `q${i}`, pageContext: page, sessionId: p5.sessionId }));
    await until(() => fake.heldCount() === 1);
    await new Promise((r) => setTimeout(r, 100));
    const refusedEarly = trio.map((t) => t.outcome.error).filter(Boolean);
    const heldWhileRefused = fake.heldCount();
    const inFlightHeld = askInFlight();
    fake.releaseHeld({ kind: 'text', text: 'held answer' });
    const trioDone = await Promise.all(trio.map((t) => t.done));
    const after = await (fake.script({ kind: 'text', text: 'next' }), ask({ question: 'q4', pageContext: page, sessionId: p5.sessionId }).done);
    report('exclusivity', { refusedEarly, heldWhileRefused, inFlightHeld, answers: trioDone.map((t) => t.answer ?? null), errors: trioDone.map((t) => t.error ?? null), after: after.answer, inFlightAfter: askInFlight() });

    // ---------------------------------------------------------------- cold resume: two follow-ups race after a "restart"
    const file = (await getAskSessionStore()).findFile(p5.sessionId)!;
    const userMessagesBefore = readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('"role":"user"')).length;
    resetAskServiceState(); // like a restart: nothing live, the JSONL on disk is the thread
    fake.script({ kind: 'hold' });
    const duo = [1, 2].map((i) => ask({ question: `cold${i}`, pageContext: page, sessionId: p5.sessionId }));
    await until(() => fake.heldCount() === 1);
    await new Promise((r) => setTimeout(r, 100));
    fake.releaseHeld({ kind: 'text', text: 'resumed' });
    const duoDone = await Promise.all(duo.map((d) => d.done));
    const userMessagesAfter = readFileSync(file, 'utf-8').split('\n').filter((l) => l.includes('"role":"user"')).length;
    report('coldResume', { answers: duoDone.map((d) => d.answer ?? null), errors: duoDone.map((d) => d.error ?? null), newUserMessages: userMessagesAfter - userMessagesBefore, inFlight: askInFlight() });

    // ---------------------------------------------------------------- compaction mid-turn: pi rewrites session.messages, the terminal error must still win
    // Twelve substantial earlier turns, then: tool prelude → context-overflow 400 → pi's default
    // auto-compaction (summarization requests) → the retried call fails with a non-retryable 400.
    fake.script({ kind: 'text', text: 'warmup '.repeat(2000) });
    const p6 = await prepareAsk({ pageContext: page });
    for (let i = 0; i < 12; i++) await ask({ question: `warmup ${i}`, pageContext: page, sessionId: p6.sessionId }).done;
    let compactionStep = 0;
    const compactionBefore = fake.requests.length;
    fake.script((request) => {
      compactionStep += 1;
      if (request.system.includes('context summarization assistant')) return { kind: 'text', text: 'Conversation summary: the user asked about a report.' };
      if (compactionStep === 1) return { kind: 'toolUse', name: 'get_report', input: { reportId: 'oversized' }, preludeText: 'Let me inspect that.' };
      if (compactionStep === 2) return { kind: 'http400', message: 'prompt is too long: 1000001 tokens > 1000000 maximum' };
      return { kind: 'http400', message: 'synthetic failure after compaction' };
    });
    const cr = await ask({ question: 'inspect huge report', pageContext: page, sessionId: p6.sessionId }).done;
    const compactionDetail = (await getAskSessionStore()).get(p6.sessionId);
    report('compaction', {
      answer: cr.answer, error: cr.error, deltas: cr.deltas, modelCalls: compactionStep,
      summarized: fake.requests.slice(compactionBefore).some((r) => r.system.includes('context summarization assistant')),
      requestMessageCounts: fake.requests.slice(compactionBefore).map((r) => r.messages.length),
      lastRecorded: compactionDetail?.turns.at(-1) && { q: compactionDetail.turns.at(-1)!.question, answer: compactionDetail.turns.at(-1)!.answer, error: compactionDetail.turns.at(-1)!.error },
      turnCount: compactionDetail?.turnCount,
    });
  } finally {
    await fake.close();
    api.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
