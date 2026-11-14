/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PiAskSessionStore — the Agent Health side of "ask sessions are pi sessions":
 * file lookup by id, listing / route filter / limit / ordering, rebuilding
 * turns from entries, crash recovery from bare pi messages, foreign files,
 * path traversal. The pi SDK itself is ESM-only (its real persistence is
 * exercised by askSessionStore.test.ts in a tsx child); here a minimal
 * SessionManager stand-in persists the same JSONL shape to REAL files so
 * every branch of the store runs in-process.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PiAskSessionStore, readSession, questionFromPrompt, ASK_META_ENTRY, ASK_TURN_ENTRY,
  type PiSessionManagerLike, type PiSessionManagerStatic,
} from '@/server/services/ask/askSessionStore';

let seq = 0;

/** pi-shaped JSONL session file: header line + entries; `<timestamp>_<id>.jsonl` in `sessionDir`. */
class FakeSessionManager implements PiSessionManagerLike {
  static created: FakeSessionManager[] = [];
  constructor(readonly file: string, readonly id: string, readonly cwd: string) {}
  static create(cwd: string, sessionDir?: string, options?: { id?: string }): FakeSessionManager {
    const id = options?.id ?? `pi-${++seq}`;
    const ts = String(Date.now() + seq).padStart(14, '0');
    const file = join(sessionDir!, `${ts}_${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: 'session', id, cwd, timestamp: new Date().toISOString() }) + '\n');
    const sm = new FakeSessionManager(file, id, cwd);
    FakeSessionManager.created.push(sm);
    return sm;
  }
  static opens = 0;
  static open(path: string): FakeSessionManager {
    FakeSessionManager.opens += 1;
    const header = JSON.parse(readFileSync(path, 'utf-8').split('\n')[0]);
    if (header.type !== 'session') throw new Error('not a pi session file');
    return new FakeSessionManager(path, header.id, header.cwd);
  }
  private append(entry: Record<string, unknown>): string {
    const id = `e${++seq}`;
    appendFileSync(this.file, JSON.stringify({ id, timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(), ...entry }) + '\n');
    return id;
  }
  getSessionId() { return this.id; }
  getSessionFile() { return this.file; }
  getHeader() { return JSON.parse(readFileSync(this.file, 'utf-8').split('\n')[0]); }
  getEntries() { return readFileSync(this.file, 'utf-8').trim().split('\n').slice(1).filter(Boolean).map((l) => JSON.parse(l)); }
  getSessionName() { return this.getEntries().filter((e) => e.type === 'session_info').map((e) => e.name).pop(); }
  appendCustomEntry(customType: string, data?: unknown) { return this.append({ type: 'custom', customType, data }); }
  appendSessionInfo(name: string) { return this.append({ type: 'session_info', name }); }
  appendMessage(message: any) { return this.append({ type: 'message', message }); }
}
const SM: PiSessionManagerStatic = FakeSessionManager;

const page = { route: '/evaluations/benchmarks/b/runs/r/inspect?reportId=x', title: 'Inspector' };
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ask583-store-')); FakeSessionManager.created = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function answered(store: PiAskSessionStore, question: string, answer: string, opts: { selections?: { text: string }[]; route?: string } = {}) {
  const selections = opts.selections ?? [{ text: 'quoted' }];
  const sm = store.create({ page: opts.route ? { route: opts.route } : page, selections, firstQuestion: question }) as FakeSessionManager;
  sm.appendMessage({ role: 'user', content: [{ type: 'text', text: `## Highlighted text\n> quoted\n\n## Question\n${question}` }] });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: answer }], provider: 'amazon-bedrock', model: 'test-model' });
  store.recordTurn(sm, { id: `t-${seq}`, question, answer, selections, startedAt: new Date(1_700_000_000_000 + seq * 1000).toISOString(), completedAt: new Date(1_700_000_000_000 + seq * 1000 + 500).toISOString(), durationMs: 500, firstTokenMs: 100, toolCalls: ['get_report'] });
  return sm;
}

describe('PiAskSessionStore.create / recordTurn', () => {
  it('creates the dir, mints an ask-<uuid> id, and writes our meta + session name as pi entries', () => {
    const store = new PiAskSessionStore(SM, join(dir, 'nested', 'ask-sessions'), '/proj');
    expect(existsSync(store.dir)).toBe(false);
    const sm = store.create({ page, selections: [{ text: 'quoted' }], firstQuestion: ' why? ' });
    expect(existsSync(store.dir)).toBe(true);
    expect(sm.getSessionId()).toMatch(/^ask-[0-9a-f-]{36}$/);
    expect(sm.getHeader()).toMatchObject({ type: 'session', cwd: '/proj' });
    const entries = sm.getEntries();
    expect(entries.find((e) => e.customType === ASK_META_ENTRY).data).toMatchObject({ page, selections: [{ text: 'quoted' }] });
    expect(sm.getSessionName()).toBe(' why? ');
    // a caller-supplied id and a blank first question → no session_info entry
    const sm2 = store.create({ id: 'ask-fixed', page, selections: [], firstQuestion: '   ' });
    expect(sm2.getSessionId()).toBe('ask-fixed');
    expect(sm2.getSessionName()).toBeUndefined();
    expect(readdirSync(store.dir)).toHaveLength(2);
  });
});

describe('PiAskSessionStore.findFile / open / get', () => {
  it('finds a session only by its exact id; rejects traversal and unknown ids; empty dir is not an error', () => {
    const store = new PiAskSessionStore(SM, join(dir, 'missing'));
    expect(store.findFile('ask-x')).toBeUndefined();
    expect(store.open('ask-x')).toBeNull();
    expect(store.get('ask-x')).toBeNull();
    expect(store.list()).toEqual([]);

    const s = new PiAskSessionStore(SM, dir);
    const sm = answered(s, 'why?', 'because');
    expect(s.findFile(sm.getSessionId())).toBe((sm as FakeSessionManager).file);
    expect(s.findFile('../../etc/passwd')).toBeUndefined();
    expect(s.open('../../etc/passwd')).toBeNull();
    expect(s.findFile('')).toBeUndefined();
    expect(s.findFile('ask-does-not-exist')).toBeUndefined();
    expect(s.get('ask-does-not-exist')).toBeNull();
    // a prefix of a real id is not a match
    expect(s.findFile(sm.getSessionId().slice(4))).toBeUndefined();
  });

  it('re-opens the persisted file and rebuilds the detail: turns, selections union, model, previews', () => {
    const s = new PiAskSessionStore(SM, dir);
    const sm = answered(s, 'why?', 'because', { selections: [{ text: 'quoted' }] });
    // a second turn adds a new selection and reuses an existing one
    (sm as FakeSessionManager).appendMessage({ role: 'user', content: 'follow-up' });
    (sm as FakeSessionManager).appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'more' }, { type: 'tool_use', id: 'x' }], provider: 'amazon-bedrock', model: 'newer-model' });
    s.recordTurn(sm, { id: 't2', question: 'and then?', answer: 'more', selections: [{ text: 'quoted' }, { text: 'another' }], startedAt: '2026-01-01T00:00:00.000Z', toolCalls: [] });

    const fresh = new PiAskSessionStore(SM, dir); // "server restart"
    const reopened = fresh.open(sm.getSessionId())!;
    expect(reopened.getSessionId()).toBe(sm.getSessionId());
    expect(reopened.getEntries().filter((e) => e.type === 'message')).toHaveLength(4);

    const detail = fresh.get(sm.getSessionId())!;
    expect(detail.turns.map((t) => t.question)).toEqual(['why?', 'and then?']);
    expect(detail.selections.map((x) => x.text)).toEqual(['quoted', 'another']);
    expect(detail.model).toBe('amazon-bedrock/newer-model');
    expect(detail.firstQuestion).toBe('why?');
    expect(detail.firstSelection).toBe('quoted');
    expect(detail.turnCount).toBe(2);
    expect(detail.lastAnswerPreview).toBe('more');
    expect(detail.updatedAt).toBe('2026-01-01T00:00:00.000Z'); // startedAt when the turn has no completedAt
    expect(detail.page).toEqual(page);
    expect('path' in detail).toBe(false);
  });
});

describe('PiAskSessionStore.list', () => {
  it('lists newest-first, filters by route, honours limit, and skips foreign / corrupt files', () => {
    const s = new PiAskSessionStore(SM, dir);
    const a = answered(s, 'first', 'a1');
    const b = answered(s, 'second', 'a2');
    const c = answered(s, 'compare q', 'a3', { route: '/compare/b?runs=x,y' });
    // foreign pi session (no ask meta) + a corrupt file + a non-jsonl file in the dir
    const foreign = FakeSessionManager.create('/elsewhere', dir);
    foreign.appendMessage({ role: 'user', content: 'hi' });
    writeFileSync(join(dir, '00000000000000_broken.jsonl'), '{not json\n');
    writeFileSync(join(dir, 'README.txt'), 'not a session');

    const all = s.list();
    expect(all.map((x) => x.firstQuestion)).toEqual(['compare q', 'second', 'first']);
    expect(all.map((x) => x.id)).toEqual([c, b, a].map((x) => x.getSessionId()));
    expect(all[0]).not.toHaveProperty('turns');
    expect(all[0]).not.toHaveProperty('selections');
    expect(s.list({ route: page.route }).map((x) => x.firstQuestion)).toEqual(['second', 'first']);
    expect(s.list({ route: '/nowhere' })).toEqual([]);
    expect(s.list({ limit: 1 }).map((x) => x.firstQuestion)).toEqual(['compare q']);
    expect(s.get(foreign.getSessionId())).toBeNull();
  });

  it('re-parses a session file only when it changed: a panel refresh over an unchanged history opens no files', () => {
    const s = new PiAskSessionStore(SM, dir);
    const a = answered(s, 'first', 'a1');
    answered(s, 'second', 'a2');
    const foreign = FakeSessionManager.create('/elsewhere', dir);
    writeFileSync(join(dir, '00000000000000_broken.jsonl'), '{not json\n');
    FakeSessionManager.opens = 0;
    expect(s.list()).toHaveLength(2);
    const firstPass = FakeSessionManager.opens;
    expect(firstPass).toBeGreaterThanOrEqual(3); // every candidate file parsed once (incl. the foreign one; the corrupt one throws before/at open)
    // the same history again (what the panel does on every refresh): nothing re-read
    expect(s.list()).toHaveLength(2);
    expect(s.list({ route: page.route })).toHaveLength(2);
    expect(FakeSessionManager.opens).toBe(firstPass);
    // one thread gets a new turn → only that file is parsed again, and the summary reflects it
    (a as FakeSessionManager).appendMessage({ role: 'user', content: 'more?' });
    (a as FakeSessionManager).appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'yes' }], stopReason: 'stop' });
    s.recordTurn(a, { id: 't-x', question: 'more?', answer: 'yes', selections: [], startedAt: '2027-01-01T00:00:00.000Z', completedAt: '2027-01-01T00:00:01.000Z', toolCalls: [] });
    const after = s.list();
    expect(FakeSessionManager.opens).toBe(firstPass + 1);
    expect(after[0]).toMatchObject({ id: a.getSessionId(), turnCount: 2, lastAnswerPreview: 'yes' });
    // a deleted file drops out (and its cache entry with it)
    rmSync((foreign as FakeSessionManager).file);
    rmSync((a as FakeSessionManager).file);
    expect(s.list().map((x) => x.firstQuestion)).toEqual(['second']);
    expect(FakeSessionManager.opens).toBe(firstPass + 1);
  });
});

describe('readSession', () => {
  it('returns null for a pi session without our meta entry', () => {
    const foreign = FakeSessionManager.create('/elsewhere', dir);
    foreign.appendMessage({ role: 'user', content: 'hi' });
    expect(readSession(foreign)).toBeNull();
  });

  it('recovers ONLY the turn whose entry is missing (crash mid-answer), as one turn spanning its tool round-trips; recorded turns stay verbatim', () => {
    const s = new PiAskSessionStore(SM, dir);
    const sm = s.create({ page, selections: [{ text: 'quoted' }], firstQuestion: 'q1' }) as FakeSessionManager;
    const user = (q: string) => sm.appendMessage({ role: 'user', content: [{ type: 'text', text: `## Page\nx\n\n## Question\n${q}` }] });
    const toolRoundTrip = (name: string, i: number) => {
      // what pi appends for a model that calls a tool before answering: assistant(toolCall) → toolResult
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Let me check.' }, { type: 'toolCall', id: `c${i}`, name, arguments: { id: 'x' } }], provider: 'p', model: 'm', stopReason: 'toolUse' });
      sm.appendMessage({ role: 'toolResult', toolCallId: `c${i}`, toolName: name, content: [{ type: 'text', text: '{"id":"x"}' }] });
    };

    // turn 1: tool call, then the answer; recorded normally
    user('q1'); toolRoundTrip('get_report', 1);
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a1 final' }], provider: 'p', model: 'm', stopReason: 'stop' });
    s.recordTurn(sm, { id: 't1', question: 'q1', answer: 'a1 final', selections: [{ text: 'quoted' }], startedAt: 's1', completedAt: 'c1', durationMs: 1200, firstTokenMs: 300, toolCalls: ['get_report'] });
    // turn 2: TWO tool calls, then the answer — the server died before writing the turn entry
    user('q2'); toolRoundTrip('get_test_case', 2); toolRoundTrip('query_spans', 3);
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a2 final' }], provider: 'p', model: 'm2', stopReason: 'stop' });
    // turn 3: recorded normally after the restart
    user('q3');
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a3' }], provider: 'p', model: 'm2', stopReason: 'stop' });
    s.recordTurn(sm, { id: 't3', question: 'q3', answer: 'a3', selections: [], startedAt: 's3', completedAt: 'c3', durationMs: 800, toolCalls: [] });

    const d = readSession(sm)!;
    expect(d.turns.map((t) => t.question)).toEqual(['q1', 'q2', 'q3']);
    // recorded turns are untouched: selections, timings, tool lists
    expect(d.turns[0]).toEqual({ id: 't1', question: 'q1', answer: 'a1 final', selections: [{ text: 'quoted' }], startedAt: 's1', completedAt: 'c1', durationMs: 1200, firstTokenMs: 300, toolCalls: ['get_report'] });
    expect(d.turns[2]).toEqual({ id: 't3', question: 'q3', answer: 'a3', selections: [], startedAt: 's3', completedAt: 'c3', durationMs: 800, toolCalls: [] });
    // the recovered turn is ONE turn: the FINAL answer (not the "Let me check." prelude), both tool calls, no error
    expect(d.turns[1]).toMatchObject({ question: 'q2', answer: 'a2 final', selections: [], toolCalls: ['get_test_case', 'query_spans'], error: undefined });
    expect(d.turns[1].startedAt).toBeTruthy();
    expect(d.turns[1].completedAt).toBeTruthy();
    expect(d.turnCount).toBe(3);
    expect(d.model).toBe('p/m2');
    expect(d.lastAnswerPreview).toBe('a3');

    // a crash AFTER a tool prelude but BEFORE the final answer is not a success: the prelude is kept as context, the turn is marked incomplete
    user('q3b'); toolRoundTrip('get_report', 9);
    expect(readSession(sm)!.turns[3]).toMatchObject({ question: 'q3b', answer: 'Let me check.', toolCalls: ['get_report'], error: 'The answer was never completed.' });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a3b' }], provider: 'p', model: 'm2', stopReason: 'stop' });
    s.recordTurn(sm, { id: 't3b', question: 'q3b', answer: 'a3b', selections: [], startedAt: 's', toolCalls: ['get_report'] });
    // a crash BEFORE any assistant text (or with a provider error) is recovered as a failed turn, not a blank success
    user('q4');
    sm.appendMessage({ role: 'assistant', content: [], provider: 'p', model: 'm2', stopReason: 'error', errorMessage: 'Throttling error: slow down' });
    user('q5');
    expect(readSession(sm)!.turns.slice(4)).toMatchObject([
      { question: 'q4', answer: '', error: 'Throttling error: slow down', toolCalls: [] },
      { question: 'q5', answer: '', error: 'The answer was never completed.', toolCalls: [] },
    ]);
  });

  it('an errored turn shows its error as the preview; an empty session falls back to the pi session name', () => {
    const s = new PiAskSessionStore(SM, dir);
    const sm = s.create({ page, selections: [{ text: 'sel' }], firstQuestion: 'named' });
    let d = readSession(sm)!;
    expect(d).toMatchObject({ firstQuestion: 'named', turnCount: 0, lastAnswerPreview: '', firstSelection: 'sel' });
    expect(d.updatedAt).toBe(d.createdAt);
    expect(d.model).toBeUndefined();
    s.recordTurn(sm, { id: 't', question: 'boom?', answer: '', selections: [], startedAt: 's', toolCalls: [], error: 'LLM unavailable' });
    d = readSession(sm)!;
    expect(d.lastAnswerPreview).toBe('LLM unavailable');
    // an unrecorded prompt whose assistant messages carry no text parts is recovered as an incomplete turn AFTER the recorded one
    (sm as FakeSessionManager).appendMessage({ role: 'user', content: [{ type: 'text', text: 'x' }] });
    (sm as FakeSessionManager).appendMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 'only' }] });
    (sm as FakeSessionManager).appendMessage({ role: 'assistant', content: 42 });
    d = readSession(sm)!;
    expect(d.turns.map((t) => [t.question, t.answer, t.error])).toEqual([['boom?', '', 'LLM unavailable'], ['x', '', 'The answer was never completed.']]);
  });

  it('questionFromPrompt strips the context we prepend and keeps a bare question', () => {
    expect(questionFromPrompt('## Page\nx\n\n## Question\nWhy did it fail?\n')).toBe('Why did it fail?');
    expect(questionFromPrompt('## Question\nfirst\n\n## Question\nlast')).toBe('last');
    expect(questionFromPrompt('plain')).toBe('plain');
  });
});
