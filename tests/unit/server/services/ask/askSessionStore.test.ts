/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ask sessions are pi sessions — exercised against the REAL pi SDK
 * SessionManager and real files (no mock of the library's persistence). The
 * SDK is ESM-only, which Jest's CJS VM cannot import, so the scenario runs in
 * a tsx child process (tests/fixtures/ask/piSessionStoreProbe.ts) and the
 * observations are asserted here. If the optional SDK is not installed the
 * probe reports `skipped` and the suite says so loudly.
 */

import { runTsxProbe } from '../../../../helpers/awsCredentialRotation';
import { questionFromPrompt } from '@/server/services/ask/askSessionStore';

type Probe = {
  skipped?: string;
  file: { inDir: boolean; suffixOk: boolean; count: number };
  header: any; meta: any; sessionInfo: string; roles: string[]; turnEntry: any; wroteToHomePi: boolean;
  listIds: string[]; expectedIds: string[]; pageQuestions: string[];
  detail: { turns: any[]; model: string; firstSelection: string; hasPath: boolean } | null;
  reopened: { sameId: boolean; sameFile: boolean; messages: number } | null;
  recovered: any[] | undefined; missing: any; traversal: any;
  foreign: { files: number; listed: number; get: any };
};

describe('PiAskSessionStore (real pi SessionManager, real files, tsx child process)', () => {
  let r: Probe;
  beforeAll(() => {
    r = runTsxProbe<Probe>('tests/fixtures/ask/piSessionStoreProbe.ts', { ...process.env, HOME: process.env.HOME });
    if (r.skipped) console.warn('SKIP — ' + r.skipped);
  });
  const skip = () => !!r.skipped;

  it('writes a pi JSONL file into the dedicated dir (not ~/.pi), with our metadata as custom entries', () => {
    if (skip()) return;
    expect(r.file).toEqual({ inDir: true, suffixOk: true, count: 1 });
    expect(r.header).toMatchObject({ type: 'session', cwd: '/some/project' });
    expect(r.meta).toMatchObject({ page: { route: '/evaluations/benchmarks/b/runs/r/inspect?reportId=x' }, selections: [{ text: 'quoted' }] });
    expect(r.sessionInfo).toBe('why?');
    expect(r.roles).toEqual(['user', 'assistant']);
    expect(r.turnEntry).toMatchObject({ question: 'why?', answer: 'because', toolCalls: ['get_report'] });
    expect(r.wroteToHomePi).toBe(false);
  });

  it('a fresh store (server restart) lists, filters by route, reads turns, and re-opens the pi session', () => {
    if (skip()) return;
    expect(r.listIds).toEqual(r.expectedIds);
    expect(r.pageQuestions).toEqual(['second question', 'why?']);
    expect(r.detail!.turns).toHaveLength(1);
    expect(r.detail!.turns[0]).toMatchObject({ question: 'second question', answer: 'second answer', durationMs: 1200, firstTokenMs: 300 });
    expect(r.detail!.model).toBe('amazon-bedrock/test-model');
    expect(r.detail!.firstSelection).toBe('quoted');
    expect(r.detail!.hasPath).toBe(false); // server file paths never reach the client
    expect(r.reopened).toEqual({ sameId: true, sameFile: true, messages: 2 });
    // a turn without our custom entry (crash mid-answer) is recovered from the pi messages
    expect(r.recovered).toHaveLength(1);
    expect(r.recovered![0]).toMatchObject({ question: 'q', answer: 'a' });
    expect(r.missing).toBeNull();
    expect(r.traversal).toBeNull();
  });

  it('ignores foreign pi sessions in the dir and never throws on them', () => {
    if (skip()) return;
    expect(r.foreign).toEqual({ files: 4, listed: 3, get: null });
  });

  it('questionFromPrompt strips the context we prepend', () => {
    expect(questionFromPrompt('## Page\nx\n\n## Question\nWhy did it fail?')).toBe('Why did it fail?');
    expect(questionFromPrompt('plain')).toBe('plain');
  });
});
