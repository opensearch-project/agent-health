/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the GENERIC report-runId recovery rule behind
 * scripts/backfill-report-run-ids.ts. Synthetic fixtures only; asserts the
 * rule has no agent/service/prefix knowledge baked in.
 */

import {
  DEFAULT_ID_FIELDS,
  isCandidate,
  pickIdField,
  rawResponseOf,
  resolveRunId,
} from '@/lib/reportRunIdRecovery';

describe('reportRunIdRecovery', () => {
  describe('isCandidate', () => {
    it('is true only for REST-connector reports with an empty runId', () => {
      expect(isCandidate({ id: 'r', connectorProtocol: 'rest' })).toBe(true);
      expect(isCandidate({ id: 'r', connectorProtocol: 'rest', runId: null })).toBe(true);
      expect(isCandidate({ id: 'r', connectorProtocol: 'rest', runId: '' })).toBe(true);
      expect(isCandidate({ id: 'r', connectorProtocol: 'rest', runId: 'have-one' })).toBe(false);
      // Other connectors mint their own run ids; never touch them.
      expect(isCandidate({ id: 'r', connectorProtocol: 'claude-code' })).toBe(false);
      expect(isCandidate({ id: 'r', connectorProtocol: 'mock' })).toBe(false);
      expect(isCandidate({ id: 'r' })).toBe(false);
    });
  });

  describe('rawResponseOf', () => {
    it('returns the LAST raw event when it is a plain object, else undefined', () => {
      expect(rawResponseOf({ id: 'r', rawEvents: [{ a: 1 }, { b: 2 }] })).toEqual({ b: 2 });
      expect(rawResponseOf({ id: 'r', rawEvents: [] })).toBeUndefined();
      expect(rawResponseOf({ id: 'r', rawEvents: null })).toBeUndefined();
      expect(rawResponseOf({ id: 'r', rawEvents: ['string-body'] })).toBeUndefined();
      expect(rawResponseOf({ id: 'r', rawEvents: [[1, 2]] })).toBeUndefined();
      expect(rawResponseOf({ id: 'r' })).toBeUndefined();
    });
  });

  describe('pickIdField', () => {
    it('returns the first non-empty STRING among the candidate fields, in list order', () => {
      expect(pickIdField({ session_id: 'abc-123', id: 'zzz' })).toEqual({ field: 'session_id', value: 'abc-123' });
      // runId outranks session_id in the default order
      expect(pickIdField({ session_id: 's', runId: 'r' })).toEqual({ field: 'runId', value: 'r' });
      // non-strings / empty strings are skipped, not coerced
      expect(pickIdField({ runId: 42, run_id: '', conversation_id: 'c-1' })).toEqual({ field: 'conversation_id', value: 'c-1' });
      expect(pickIdField({ runId: { nested: 'x' } })).toBeUndefined();
      expect(pickIdField({ answer: 'text only' })).toBeUndefined();
      expect(pickIdField(undefined)).toBeUndefined();
    });

    it('honours a caller-supplied field list (configurable, not tied to any agent)', () => {
      expect(pickIdField({ session_id: 's', trace_ref: 't' }, ['trace_ref'])).toEqual({ field: 'trace_ref', value: 't' });
      expect(pickIdField({ session_id: 's' }, ['trace_ref'])).toBeUndefined();
    });

    it('default candidate list contains no agent-specific names', () => {
      for (const f of DEFAULT_ID_FIELDS) expect(f).toMatch(/^(runId|run_id|session_id|sessionId|conversation_id|conversationId|id)$/);
    });
  });

  describe('resolveRunId', () => {
    const report = (raw: unknown) => ({ id: 'report-1', connectorProtocol: 'rest', rawEvents: [raw] });

    it('uses the candidate-field rule when no hook is given', async () => {
      await expect(resolveRunId(report({ answer: '…', session_id: 'sid-9' }))).resolves.toEqual({
        reportId: 'report-1', runId: 'sid-9', source: 'field:session_id',
      });
    });

    it('the agent\'s afterResponse hook is authoritative when it returns a string runId', async () => {
      const hook = jest.fn(async (ctx: any) => ({ ...ctx, runId: `${ctx.response.answer_ref}-from-hook` }));
      await expect(resolveRunId(report({ answer_ref: 'x', session_id: 'ignored' }), { hook })).resolves.toEqual({
        reportId: 'report-1', runId: 'x-from-hook', source: 'hook',
      });
      // The hook sees the raw response as `response` plus the raw events.
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ response: { answer_ref: 'x', session_id: 'ignored' }, trajectory: [] }));
    });

    it('falls back to the field rule when the hook returns no runId, and records that in the reason when nothing is found', async () => {
      const noRunId = jest.fn(async (ctx: any) => ({ ...ctx }));
      await expect(resolveRunId(report({ session_id: 'sid-2' }), { hook: noRunId })).resolves.toMatchObject({ runId: 'sid-2', source: 'field:session_id' });
      const r = await resolveRunId(report({ answer: 'no ids here' }), { hook: noRunId });
      expect(r.runId).toBeUndefined();
      expect(r.reason).toMatch(/hook returned no runId/);
      expect(r.reason).toMatch(/keys: answer/);
    });

    it('a throwing hook never aborts the run — it degrades to the field rule', async () => {
      const boom = jest.fn(async () => { throw new Error('kaboom'); });
      await expect(resolveRunId(report({ run_id: 'rid' }), { hook: boom })).resolves.toMatchObject({ runId: 'rid', source: 'field:run_id' });
      const r = await resolveRunId(report({}), { hook: boom });
      expect(r.runId).toBeUndefined();
      expect(r.reason).toMatch(/hook threw \(kaboom\)/);
    });

    it('reports with no raw response body are unresolved', async () => {
      await expect(resolveRunId({ id: 'report-2', connectorProtocol: 'rest', rawEvents: [] })).resolves.toEqual({
        reportId: 'report-2', reason: 'no raw response body on report',
      });
    });

    it('custom idFields are respected end to end', async () => {
      await expect(resolveRunId(report({ session_id: 's', ticket: 'T-1' }), { idFields: ['ticket'] })).resolves.toMatchObject({ runId: 'T-1', source: 'field:ticket' });
    });
  });
});
