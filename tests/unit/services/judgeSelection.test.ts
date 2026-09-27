/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { stampJudgeSelection, formatJudgeSelectionConflictWarnings } from '@/services/judgeSelection';
import type { JudgeSelectionSnapshot } from '@/lib/testCases/judge';

const ctx = { testCaseId: 'tc-1', testCaseName: 'my case', logPrefix: '[T]' };

function snap(over: Partial<JudgeSelectionSnapshot> = {}): JudgeSelectionSnapshot {
  return {
    applied: { evaluatorId: 'system-rca-default', evaluatorIdSource: 'run', modelId: 'demo-model', modelIdSource: 'run' },
    conflicts: [],
    judgeCalls: 1,
    ...over,
  };
}

describe('stampJudgeSelection', () => {
  it('is a no-op when the body made no judge calls (or no binding)', () => {
    const report: any = { evaluatorId: 'x' };
    stampJudgeSelection(report, undefined, { evaluatorId: 'x' }, ctx);
    stampJudgeSelection(report, snap({ judgeCalls: 0 }), { evaluatorId: 'x' }, ctx);
    expect(report).toEqual({ evaluatorId: 'x' });
  });

  it('stamps judgeApplied + truthful labels (run selected → labels unchanged) and no conflicts key when none', () => {
    const report: any = {};
    const warn = jest.fn();
    stampJudgeSelection(report, snap(), { evaluatorId: 'system-rca-default', judgeModelId: 'demo-model' }, { ...ctx, warn });
    expect(report.judgeApplied).toEqual(snap().applied);
    expect(report.evaluatorId).toBe('system-rca-default');
    expect(report.judgeModelId).toBe('demo-model');
    expect(report).not.toHaveProperty('judgeSelectionConflicts');
    expect(warn).not.toHaveBeenCalled();
  });

  it('run did NOT select → the unanimous body pin becomes the label (source body)', () => {
    const report: any = {};
    stampJudgeSelection(
      report,
      snap({ applied: { evaluatorId: 'system-factuality', evaluatorIdSource: 'body', modelId: undefined, modelIdSource: 'default' } }),
      {},
      ctx,
    );
    expect(report.evaluatorId).toBe('system-factuality');
    expect(report.judgeModelId).toBeUndefined();
  });

  it('records conflicts on the report and warns ONCE per field', () => {
    const report: any = {};
    const warn = jest.fn();
    const conflicts = [
      { field: 'evaluatorId' as const, runValue: 'system-rca-default', bodyValue: 'system-factuality' },
      { field: 'evaluatorId' as const, runValue: 'system-rca-default', bodyValue: 'system-safety' },
      { field: 'modelId' as const, runValue: 'demo-model', bodyValue: 'some-other-model' },
    ];
    stampJudgeSelection(report, snap({ conflicts }), { evaluatorId: 'system-rca-default', judgeModelId: 'demo-model' }, { ...ctx, warn });
    expect(report.judgeSelectionConflicts).toEqual(conflicts);
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map(c => c[0] as string);
    expect(lines[0]).toContain('[T] judge selection conflict on test case "my case" (tc-1)');
    expect(lines[0]).toContain('evaluatorId="system-factuality", "system-safety"');
    expect(lines[0]).toContain('run selected "system-rca-default"');
    expect(lines[1]).toContain('modelId="some-other-model"');
  });

  it('formatJudgeSelectionConflictWarnings falls back to the id when no name', () => {
    const [line] = formatJudgeSelectionConflictWarnings(
      [{ field: 'modelId', runValue: 'a', bodyValue: 'b' }],
      { testCaseId: 'tc-9', logPrefix: '[P]' },
    );
    expect(line).toContain('test case tc-9:');
    expect(line).toContain('run selection applied');
  });
});
