/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask sessions ARE pi sessions.
 *
 * Every "highlight & ask" thread is a pi session persisted by pi's own
 * `SessionManager` in pi's JSONL session format — one file per thread under a
 * DEDICATED directory (`<cwd>/.agent-health/ask-sessions/`, override with
 * `AH_ASK_SESSIONS_DIR`), NOT the default `~/.pi/agent/sessions/<cwd>` dir, so
 * they don't flood the user's pi-web sidebar. A follow-up re-opens the same
 * file (`SessionManager.open`) and pi rebuilds the model context from it, so
 * threads survive a server restart.
 *
 * Agent Health metadata rides along as pi `custom` entries (they never enter
 * the LLM context):
 *   - `agent-health.ask`       once, right after creation: page route/title + first selections
 *   - `agent-health.ask.turn`  after every answered question: question, answer, selections, timings, tools
 * The user/assistant messages themselves are the ordinary pi message entries.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { AskPageContext, AskSelection } from './askContext';

export const ASK_META_ENTRY = 'agent-health.ask';
export const ASK_TURN_ENTRY = 'agent-health.ask.turn';

export interface AskSessionMeta {
  page: AskPageContext;
  selections: AskSelection[];
  createdAt: string;
}

export interface AskTurn {
  id: string;
  question: string;
  answer: string;
  selections: AskSelection[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  firstTokenMs?: number;
  toolCalls: string[];
  error?: string;
}

export interface AskSessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  page: AskPageContext;
  firstQuestion: string;
  firstSelection?: string;
  turnCount: number;
  lastAnswerPreview: string;
  model?: string;
}

export interface AskSessionDetail extends AskSessionSummary {
  selections: AskSelection[];
  turns: AskTurn[];
}

/** The subset of pi's SessionManager class this store drives (typed loosely: the SDK is an optional dep). */
export interface PiSessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getEntries(): any[];
  getSessionName(): string | undefined;
  getHeader(): any;
  appendCustomEntry(customType: string, data?: unknown): string;
  appendSessionInfo(name: string): string;
}
export interface PiSessionManagerStatic {
  create(cwd: string, sessionDir?: string, options?: { id?: string }): PiSessionManagerLike;
  open(path: string, sessionDir?: string, cwdOverride?: string): PiSessionManagerLike;
}

export class PiAskSessionStore {
  /**
   * Per-file summaries keyed by (mtime, size): a panel refresh lists every
   * thread, and parsing every JSONL on every GET is unbounded synchronous work
   * on the event loop as history grows. Unchanged files are not re-read.
   */
  private readonly summaries = new Map<string, { mtimeMs: number; size: number; summary: AskSessionSummary | null }>();

  constructor(
    private readonly SessionManager: PiSessionManagerStatic,
    readonly dir: string,
    private readonly cwd: string = process.cwd()
  ) {}

  /** New pi session file (written by pi on the first assistant message) + our meta entry. */
  create(input: { id?: string; page: AskPageContext; selections: AskSelection[]; firstQuestion?: string }): PiSessionManagerLike {
    mkdirSync(this.dir, { recursive: true });
    const sm = this.SessionManager.create(this.cwd, this.dir, { id: input.id ?? `ask-${randomUUID()}` });
    const meta: AskSessionMeta = { page: input.page, selections: input.selections, createdAt: new Date().toISOString() };
    sm.appendCustomEntry(ASK_META_ENTRY, meta);
    // pi's display name for the session = the first question (what pi-web / `pi --resume` would show).
    if (input.firstQuestion?.trim()) sm.appendSessionInfo(input.firstQuestion.slice(0, 120));
    return sm;
  }

  /** Locate a session file by its pi session id (`<timestamp>_<id>.jsonl`). */
  findFile(id: string): string | undefined {
    if (!existsSync(this.dir)) return undefined;
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe || safe !== id) return undefined;
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(`_${id}.jsonl`))
      .map((f) => join(this.dir, f))[0];
  }

  /** Re-open a persisted session (follow-up after a restart). */
  open(id: string): PiSessionManagerLike | null {
    const file = this.findFile(id);
    return file ? this.SessionManager.open(file, this.dir) : null;
  }

  recordTurn(sm: PiSessionManagerLike, turn: AskTurn): void {
    sm.appendCustomEntry(ASK_TURN_ENTRY, turn);
  }

  get(id: string): AskSessionDetail | null {
    const file = this.findFile(id);
    if (!file) return null;
    return readSession(this.SessionManager.open(file, this.dir));
  }

  list(opts: { route?: string; limit?: number } = {}): AskSessionSummary[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.jsonl'));
    const present = new Set(files);
    for (const k of this.summaries.keys()) if (!present.has(k)) this.summaries.delete(k);
    const out: AskSessionSummary[] = [];
    for (const f of files) {
      const summary = this.summaryOf(f);
      if (!summary) continue;
      if (opts.route && summary.page.route !== opts.route) continue;
      out.push(summary);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, opts.limit ?? 200);
  }

  /** Summary of one file, parsed only when the file changed since the last call. */
  private summaryOf(file: string): AskSessionSummary | null {
    const path = join(this.dir, file);
    let st: { mtimeMs: number; size: number };
    try { st = statSync(path); } catch { return null; }
    const cached = this.summaries.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.summary;
    let summary: AskSessionSummary | null = null;
    try {
      const detail = readSession(this.SessionManager.open(path, this.dir));
      if (detail) {
        const { selections: _s, turns: _t, ...rest } = detail;
        summary = rest;
      }
    } catch {
      // A foreign / corrupt file in the dir is skipped, never fatal.
    }
    this.summaries.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
    return summary;
  }
}

function textOf(message: any): string {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('');
  return '';
}

/**
 * One prompt and everything pi appended for it: the user message, then the
 * assistant / tool-result messages up to (not including) the next user message.
 */
interface MessageGroup { user: any; replies: any[] }

/** An AskTurn rebuilt from bare pi messages (the custom turn entry never got written: crash mid-answer). */
function recoverTurn(g: MessageGroup): AskTurn {
  const assistants = g.replies.filter((e) => e.message?.role === 'assistant');
  const terminal = assistants[assistants.length - 1];
  let answer = '';
  for (const e of assistants) { const t = textOf(e.message); if (t.trim()) answer = t; }
  const toolCalls = assistants.flatMap((e) =>
    Array.isArray(e.message?.content) ? e.message.content.filter((c: any) => c?.type === 'toolCall' && typeof c.name === 'string').map((c: any) => c.name as string) : []
  );
  const last = g.replies[g.replies.length - 1] ?? g.user;
  // A turn only completed if its LAST reply is an assistant message that stopped
  // on its own: a tool call still waiting for its result, or a tool result with
  // no answer after it, is a crash mid-answer even when earlier text exists.
  const completed = terminal && last === terminal && terminal.message?.stopReason !== 'toolUse';
  let error: string | undefined;
  if (terminal?.message?.stopReason === 'error') error = terminal.message.errorMessage || 'The model call failed.';
  else if (terminal?.message?.stopReason === 'aborted') error = 'The answer was interrupted.';
  else if (!completed || !answer.trim()) error = 'The answer was never completed.';
  return {
    id: g.user.id, question: questionFromPrompt(textOf(g.user.message)), answer, selections: [],
    startedAt: g.user.timestamp, completedAt: last.timestamp, toolCalls, error,
  };
}

/**
 * Rebuild the Agent Health view of a pi session from its entries. Returns null
 * for files that aren't ask sessions.
 *
 * Turns come from our `agent-health.ask.turn` entries, each written right after
 * its prompt's messages. A prompt whose entry is MISSING (the server died
 * mid-answer) is recovered from the bare pi messages in its place — only that
 * one; recorded turns keep their answers, selections, timings and tool lists.
 */
export function readSession(sm: PiSessionManagerLike): AskSessionDetail | null {
  const entries = sm.getEntries();
  const metaEntry = entries.find((e) => e.type === 'custom' && e.customType === ASK_META_ENTRY);
  if (!metaEntry) return null;
  const meta = metaEntry.data as AskSessionMeta;
  const messages = entries.filter((e) => e.type === 'message');
  const turns: AskTurn[] = [];
  let open: MessageGroup | null = null;
  for (const e of entries) {
    if (e.type === 'message') {
      const role = e.message?.role;
      if (role === 'user') {
        if (open) turns.push(recoverTurn(open));
        open = { user: e, replies: [] };
      } else if (open && (role === 'assistant' || role === 'toolResult')) {
        open.replies.push(e);
      }
    } else if (e.type === 'custom' && e.customType === ASK_TURN_ENTRY) {
      turns.push(e.data as AskTurn); // covers the prompt whose messages precede it
      open = null;
    }
  }
  if (open) turns.push(recoverTurn(open));
  let model: string | undefined;
  for (const e of messages) if (e.message?.role === 'assistant' && e.message?.model) model = `${e.message.provider ? e.message.provider + '/' : ''}${e.message.model}`;
  const selections: AskSelection[] = [...(meta.selections ?? [])];
  for (const t of turns) for (const s of t.selections ?? []) if (!selections.some((x) => x.text === s.text)) selections.push(s);
  const last = turns[turns.length - 1];
  const updatedAt = last?.completedAt ?? last?.startedAt ?? meta.createdAt;
  return {
    id: sm.getSessionId(),
    createdAt: meta.createdAt,
    updatedAt,
    page: meta.page,
    firstQuestion: turns[0]?.question ?? sm.getSessionName() ?? '',
    firstSelection: selections[0]?.text?.slice(0, 160),
    turnCount: turns.length,
    lastAnswerPreview: (last?.answer || last?.error || '').slice(0, 200),
    model,
    selections,
    turns,
  };
}

/** The question is the last `## Question` section of the prompt we send (see askContext.buildAskUserPrompt). */
export function questionFromPrompt(prompt: string): string {
  const i = prompt.lastIndexOf('## Question\n');
  return (i >= 0 ? prompt.slice(i + '## Question\n'.length) : prompt).trim();
}
