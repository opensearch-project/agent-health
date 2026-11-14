/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Probe run by tests/unit/server/services/ask/askSessionStore.test.ts in a
 * child Node process (tsx): drives PiAskSessionStore against the REAL pi SDK
 * SessionManager (ESM-only, so Jest's CJS VM cannot import it) and real files,
 * then prints one JSON line of observations for the Jest assertions.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PiAskSessionStore, ASK_META_ENTRY, ASK_TURN_ENTRY } from '../../../server/services/ask/askSessionStore';

async function main() {
  let SessionManager: any;
  try {
    ({ SessionManager } = await import('@earendil-works/pi-coding-agent'));
  } catch (err: any) {
    console.log(JSON.stringify({ skipped: `pi SDK not installed: ${err?.message ?? err}` }));
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'ask-pi-sessions-probe-'));
  const page = { route: '/evaluations/benchmarks/b/runs/r/inspect?reportId=x', title: 'Inspector' };
  const out: Record<string, unknown> = {};
  try {
    const answered = (store: PiAskSessionStore, question: string, answer: string, selections = [{ text: 'quoted' }]) => {
      const sm: any = store.create({ page, selections, firstQuestion: question });
      // What pi itself appends during session.prompt(): the user and assistant messages.
      sm.appendMessage({ role: 'user', content: [{ type: 'text', text: `## Highlighted text\n> quoted\n\n## Question\n${question}` }], timestamp: Date.now() });
      sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: answer }], provider: 'amazon-bedrock', model: 'test-model', timestamp: Date.now(), api: 'x', usage: {}, stopReason: 'stop' });
      store.recordTurn(sm, { id: 't1', question, answer, selections, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 1200, firstTokenMs: 300, toolCalls: ['get_report'] });
      return sm;
    };

    // 1. file layout + entries
    const a = new PiAskSessionStore(SessionManager, dir, '/some/project');
    const s1 = answered(a, 'why?', 'because');
    const file: string = s1.getSessionFile();
    const lines = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    out.file = { inDir: file.startsWith(dir), suffixOk: file.endsWith(`_${s1.getSessionId()}.jsonl`), count: readdirSync(dir).length };
    out.header = lines[0];
    out.meta = lines.find((l) => l.type === 'custom' && l.customType === ASK_META_ENTRY)?.data;
    out.sessionInfo = lines.find((l) => l.type === 'session_info')?.name;
    out.roles = lines.filter((l) => l.type === 'message').map((l) => l.message.role);
    out.turnEntry = lines.find((l) => l.type === 'custom' && l.customType === ASK_TURN_ENTRY)?.data;
    out.wroteToHomePi = existsSync(join(process.env.HOME ?? '/nonexistent', '.pi', 'agent', 'sessions', 'some-project'));

    // 2. fresh instance (restart): list / filter / get / open
    const s2 = answered(a, 'second question', 'second answer');
    const other: any = a.create({ page: { route: '/compare/b?runs=x,y' }, selections: [], firstQuestion: 'compare q' });
    other.appendMessage({ role: 'user', content: [{ type: 'text', text: 'q' }], timestamp: Date.now() });
    other.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a' }], provider: 'p', model: 'm', timestamp: Date.now(), api: 'x', usage: {}, stopReason: 'stop' });
    const b = new PiAskSessionStore(SessionManager, dir);
    out.listIds = b.list().map((s) => s.id).sort();
    out.expectedIds = [s1.getSessionId(), s2.getSessionId(), other.getSessionId()].sort();
    out.pageQuestions = b.list({ route: page.route }).map((s) => s.firstQuestion).sort();
    const detail = b.get(s2.getSessionId());
    out.detail = detail && { turns: detail.turns, model: detail.model, firstSelection: detail.firstSelection, hasPath: 'path' in (detail as any) };
    const reopened: any = b.open(s2.getSessionId());
    out.reopened = reopened && { sameId: reopened.getSessionId() === s2.getSessionId(), sameFile: reopened.getSessionFile() === s2.getSessionFile(), messages: reopened.getEntries().filter((e: any) => e.type === 'message').length };
    out.recovered = b.get(other.getSessionId())?.turns;
    out.missing = b.get('ask-does-not-exist');
    out.traversal = b.open('../../etc/passwd');

    // 3. foreign pi session in the dir
    const foreign = SessionManager.create('/elsewhere', dir);
    foreign.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() });
    foreign.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'yo' }], provider: 'p', model: 'm', timestamp: Date.now(), api: 'x', usage: {}, stopReason: 'stop' });
    out.foreign = { files: readdirSync(dir).length, listed: b.list().length, get: b.get(foreign.getSessionId()) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(JSON.stringify(out));
}

main().catch((err) => { console.error(err); process.exit(1); });
