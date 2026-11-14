/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The assistant service on the REAL pi SDK and the REAL AWS SDK — no mock of
 * either library. A scripted local Bedrock (ConverseStream wire protocol) and a
 * local API that holds tool lookups make every scenario deterministic; the
 * scenario runs in a tsx child process (tests/fixtures/ask/askRealSdkProbe.ts,
 * the SDK is ESM-only and the AWS credential chain uses dynamic import()) with
 * a temp credentials file that is ROTATED mid-run. Observations are asserted
 * here. Without the optional pi SDK the probe reports `skipped`, loudly.
 *
 * Each `it` is one review finding on #583; the probe's `rotation.plainAfterRotation`
 * is the library claim itself (the AWS SDK caches the credentials file for the
 * life of the process, so the old "recreate the runtime every 5 min" never
 * picked up a rotated key).
 */

import { createAwsProfileDir, runTsxProbe, STATIC_KEY, type AwsProfileDir } from '../../../../helpers/awsCredentialRotation';

type Probe = {
  skipped?: string;
  model: string;
  rotation: { plainBefore: string; plainAfterRotation: string; askBefore: string; askBeforeToken: string; askBeforeAnswer: string; askAfterRotation: string; askAfterRotationToken: string; askAfterAnswer: string; sameSession: boolean };
  failedFollowUp: { firstAnswer: string; httpError: { answer?: string; error?: string; deltas: string[] }; dropped: { answer?: string; error?: string; deltas: string[] }; recorded: Array<{ q: string; answer: string; error?: string }> };
  toolAbort: { heldSeen: boolean; inFlightDuring: number; freed: boolean; slotFreedMs: number; lookupClosed: boolean | null; settled: boolean; tools: string[] };
  toolAbortReuse: { answer?: string; error?: string };
  toolBudget: { error?: string; answer?: string; lookupsDispatched: number; toolStarts: number; modelCalls: number; inFlight: number };
  toolBudgetBatch: { error?: string; answer?: string; lookupsDispatched: number; toolStarts: number; batchResults: string[]; inFlight: number };
  compaction: { answer?: string; error?: string; deltas: string[]; modelCalls: number; summarized: boolean; requestMessageCounts: number[]; lastRecorded?: { q: string; answer: string; error?: string }; turnCount?: number };
  readOnly: { offered: string[]; expected: string[]; toolResults: Array<{ status: string; text: string }>; markerExists: boolean; answer?: string; error?: string; tools: string[] };
  exclusivity: { refusedEarly: string[]; heldWhileRefused: number; inFlightHeld: number; answers: Array<string | null>; errors: Array<string | null>; after?: string; inFlightAfter: number };
  coldResume: { answers: Array<string | null>; errors: Array<string | null>; newUserMessages: number; inFlight: number };
};

describe('askService on the real pi SDK + real AWS SDK (scripted local Bedrock, tsx child process)', () => {
  let aws: AwsProfileDir;
  let r: Probe;
  beforeAll(() => {
    aws = createAwsProfileDir(); // profile `rotation-test` = key A; the probe rotates it to B
    r = runTsxProbe<Probe>('tests/fixtures/ask/askRealSdkProbe.ts', { ...aws.env, HOME: process.env.HOME }, 170_000);
    if (r.skipped) console.warn('SKIP — ' + r.skipped);
  }, 180_000);
  afterAll(() => aws?.cleanup());
  const skip = () => !!r.skipped;

  it('HIGH 1 — Bedrock credential rotation: a live session signs with the key on disk NOW; the plain runtime (old code) keeps the cached key', () => {
    if (skip()) return;
    expect(r.model).toMatch(/^amazon-bedrock\//);
    expect(r.rotation.askBefore).toBe(STATIC_KEY.A.accessKeyId);
    expect(r.rotation.askBeforeToken).toBe(STATIC_KEY.A.sessionToken);
    expect(r.rotation.askBeforeAnswer).toBe('Answer one.');
    // The library claim, measured: a NEW ModelRuntime after the rotation still signs with A.
    expect(r.rotation.plainBefore).toBe(STATIC_KEY.A.accessKeyId);
    expect(r.rotation.plainAfterRotation).toBe(STATIC_KEY.A.accessKeyId);
    // The fix: the SAME live session, one TTL later, signs with B — no restart, no new runtime.
    expect(r.rotation.sameSession).toBe(true);
    expect(r.rotation.askAfterRotation).toBe(STATIC_KEY.B.accessKeyId);
    expect(r.rotation.askAfterRotationToken).toBe(STATIC_KEY.B.sessionToken);
    expect(r.rotation.askAfterAnswer).toBe('Answer one.');
  });

  it('HIGH 2 — a failed follow-up is reported as THAT turn\'s error (HTTP 400; stream dropped mid-answer), never as the previous answer; failed turns are persisted', () => {
    if (skip()) return;
    expect(r.failedFollowUp.firstAnswer).toBe('Answer one.');
    expect(r.failedFollowUp.httpError.answer).toBeUndefined();
    expect(r.failedFollowUp.httpError.error).toBe('Validation error: synthetic validation failure');
    expect(r.failedFollowUp.dropped.answer).toBeUndefined();
    expect(r.failedFollowUp.dropped.error).toMatch(/socket hang up|aborted|closed|terminated/);
    expect(r.failedFollowUp.recorded.map((t) => t.q)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(r.failedFollowUp.recorded[2]).toEqual({ q: 'third', answer: '', error: 'Validation error: synthetic validation failure' });
    expect(r.failedFollowUp.recorded[3]).toMatchObject({ q: 'fourth', answer: '', error: expect.any(String) });
  });

  it('HIGH 4 — a client disconnect during a held tool lookup tears the lookup down, settles prompt() and frees the slot within a bounded interval', () => {
    if (skip()) return;
    expect(r.toolAbort.heldSeen).toBe(true);
    expect(r.toolAbort.inFlightDuring).toBe(1);
    expect(r.toolAbort.tools).toEqual(['get_report:start']);
    expect(r.toolAbort.freed).toBe(true);
    expect(r.toolAbort.slotFreedMs).toBeLessThan(2000);
    expect(r.toolAbort.lookupClosed).toBe(true);
    expect(r.toolAbort.settled).toBe(false); // nothing is sent to a client that left
    expect(r.toolAbortReuse).toEqual({ answer: 'after tool', error: undefined }); // the session and the slot are reusable
  });

  it('HIGH 4 — turn budget: a model that loops on lookups is cut off after assistant.maxToolCalls with an error that says so', () => {
    if (skip()) return;
    expect(r.toolBudget.error).toBe('The assistant stopped after 3 tool lookups (assistant.maxToolCalls).');
    expect(r.toolBudget.answer).toBeUndefined();
    expect(r.toolBudget.lookupsDispatched).toBe(3); // exactly the budget reached this server's API; the 4th was refused before dispatch
    expect(r.toolBudget.modelCalls).toBeLessThanOrEqual(4);
    expect(r.toolBudget.inFlight).toBe(0);
  });

  it('HIGH 4 — turn budget holds for a PARALLEL batch: five lookups in one model response → three served, two refused before dispatch; the next over-budget response ends the turn', () => {
    if (skip()) return;
    expect(r.toolBudgetBatch.lookupsDispatched).toBe(3);
    expect(r.toolBudgetBatch.batchResults).toEqual(['served', 'served', 'served', 'refused', 'refused']);
    expect(r.toolBudgetBatch.error).toBe('The assistant stopped after 3 tool lookups (assistant.maxToolCalls).');
    expect(r.toolBudgetBatch.answer).toBeUndefined();
    expect(r.toolBudgetBatch.inFlight).toBe(0);
  });

  it('HIGH 2 — auto-compaction mid-turn (pi rewrites session.messages) does not turn a terminal provider error into the prelude text as a success', () => {
    if (skip()) return;
    expect(r.compaction.summarized).toBe(true); // pi really compacted: summarization requests were made
    expect(Math.min(...r.compaction.requestMessageCounts)).toBeLessThan(Math.max(...r.compaction.requestMessageCounts)); // the history shrank mid-turn
    expect(r.compaction.error).toBe('Validation error: synthetic failure after compaction');
    expect(r.compaction.answer).toBeUndefined();
    expect(r.compaction.deltas[0]).toBe('Let me inspect that.'); // what streamed before the failure stays visible to the client
    expect(r.compaction.lastRecorded).toEqual({ q: 'inspect huge report', answer: 'Let me inspect that.', error: 'Validation error: synthetic failure after compaction' });
    expect(r.compaction.turnCount).toBe(13); // 12 warm-ups + the failed one, persisted as failed
  });

  it('MEDIUM — read-only enforcement with real tool dispatch: `bash` and `write` requested by the model are refused by pi, nothing is written, exactly ASK_TOOLS were offered', () => {
    if (skip()) return;
    expect(r.readOnly.offered).toEqual(r.readOnly.expected);
    expect(r.readOnly.offered).toEqual(['get_report', 'get_evaluation_run', 'get_test_case', 'get_benchmark', 'query_spans']);
    expect(r.readOnly.toolResults.map((t) => t.status)).toEqual(expect.arrayContaining(['error']));
    expect(r.readOnly.toolResults.map((t) => t.text)).toEqual(expect.arrayContaining(['Tool bash not found', 'Tool write not found']));
    expect(r.readOnly.toolResults.every((t) => t.status === 'error')).toBe(true);
    expect(r.readOnly.markerExists).toBe(false);
    expect(r.readOnly.answer).toBe('gave up');
  });

  it('HIGH 3 — three questions at once on one held session: exactly one runs, two are refused, the hold survives the refusals; concurrent cold resumes open ONE pi session', () => {
    if (skip()) return;
    expect(r.exclusivity.refusedEarly).toEqual(['This ask session is still answering a previous question.', 'This ask session is still answering a previous question.']);
    expect(r.exclusivity.heldWhileRefused).toBe(1); // the model call of the holder is still in flight
    expect(r.exclusivity.inFlightHeld).toBe(1); // the refusals did not touch the holder's slot
    expect(r.exclusivity.answers.filter((a) => a === 'held answer')).toHaveLength(1);
    expect(r.exclusivity.errors.filter(Boolean)).toHaveLength(2);
    expect(r.exclusivity.after).toBe('next');
    expect(r.exclusivity.inFlightAfter).toBe(0);
    expect(r.coldResume.answers.filter((a) => a === 'resumed')).toHaveLength(1);
    expect(r.coldResume.errors.filter(Boolean)).toEqual(['This ask session is still answering a previous question.']);
    expect(r.coldResume.newUserMessages).toBe(1); // one writer on the JSONL, not two
    expect(r.coldResume.inFlight).toBe(0);
  });
});
