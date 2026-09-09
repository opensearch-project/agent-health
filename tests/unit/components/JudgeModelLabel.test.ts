/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL: the shared JudgeModelLabel — "judge kind · underlying LLM" — and the
 * `getJudgeModelDisplay` helper behind it.
 *
 * Owner ask: "Rename the field to call out the model of the pi judge too."
 * `agent-trace-judge` is a PROVIDER; the LLM behind it is `judgeModel`.
 *   - recorded  -> "Agent Trace Judge (…) · claude-sonnet-4-5"
 *   - old report -> "Agent Trace Judge (…) · model not recorded — auto-picked at run time"
 *   - bedrock    -> "Claude Sonnet 4.6" (one label; judgeModel == judgeModelId)
 *   - none       -> "—"
 */

import * as React from 'react';
import { render, screen, cleanup } from '@testing-library/react';

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [],
    models: {
      'agent-trace-judge': { model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent' },
      'claude-sonnet-4.6': { model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock' },
    },
  },
}));

import { JudgeModelLabel, judgeModelText } from '@/components/JudgeModelLabel';
import { getJudgeModelDisplay } from '@/lib/utils';

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

describe('getJudgeModelDisplay', () => {
  it('agent judge with a recorded model: kind label + short model detail', () => {
    const d = getJudgeModelDisplay({ judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45 });
    expect(d.label).toBe('Agent Trace Judge (pi SDK + query_spans)');
    expect(d.detail).toBe('claude-sonnet-4-5');
    expect(d.hint).toBeUndefined();
    expect(d.title).toContain(SONNET_45);
  });
  it('agent judge, old report (no judgeModel): kind label + "not recorded" hint, never the provider as a model', () => {
    const d = getJudgeModelDisplay({ judgeModelId: 'agent-trace-judge' });
    expect(d.label).toBe('Agent Trace Judge (pi SDK + query_spans)');
    expect(d.detail).toBeUndefined();
    expect(d.hint).toBe('model not recorded — auto-picked at run time');
  });
  it('bedrock: a single label (judgeModel equals the configured id), no detail, no hint', () => {
    const d = getJudgeModelDisplay({ judgeModelId: 'claude-sonnet-4.6', judgeModel: 'claude-sonnet-4.6' });
    expect(d.label).toBe('Claude Sonnet 4.6');
    expect(d.detail).toBeUndefined();
    expect(d.hint).toBeUndefined();
    // and with no judgeModel recorded at all (pre-fix bedrock run) — still no hint: it IS the model
    expect(getJudgeModelDisplay({ judgeModelId: 'claude-sonnet-4.6' }).hint).toBeUndefined();
  });
  it('unknown-id bedrock run whose resolved model differs from the configured key shows both', () => {
    const d = getJudgeModelDisplay({ judgeModelId: 'claude-sonnet-4.6', judgeModel: 'us.anthropic.claude-sonnet-4-6' });
    expect(d.label).toBe('Claude Sonnet 4.6');
    expect(d.detail).toBe('claude-sonnet-4-6');
  });
  it('no judge at all: em dash', () => {
    expect(getJudgeModelDisplay(undefined).label).toBe('—');
    expect(getJudgeModelDisplay({}).label).toBe('—');
  });
});

describe('<JudgeModelLabel />', () => {
  afterEach(() => cleanup());

  it('renders kind + resolved model for an agent-trace-judge report that recorded its LLM', () => {
    render(React.createElement(JudgeModelLabel, { run: { judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45 } }));
    expect(screen.getByTestId('judge-model-kind').textContent).toBe('Agent Trace Judge (pi SDK + query_spans)');
    expect(screen.getByTestId('judge-model-resolved').textContent).toContain('claude-sonnet-4-5');
    expect(screen.queryByTestId('judge-model-not-recorded')).toBeNull();
    expect(screen.getByTestId('judge-model-label').getAttribute('title')).toContain(SONNET_45);
  });

  it('falls back for old reports: kind + "model not recorded" hint (hidden in compact mode)', () => {
    render(React.createElement(JudgeModelLabel, { run: { judgeModelId: 'agent-trace-judge' } }));
    expect(screen.getByTestId('judge-model-kind').textContent).toBe('Agent Trace Judge (pi SDK + query_spans)');
    expect(screen.queryByTestId('judge-model-resolved')).toBeNull();
    expect(screen.getByTestId('judge-model-not-recorded').textContent).toContain('model not recorded');
    cleanup();
    render(React.createElement(JudgeModelLabel, { run: { judgeModelId: 'agent-trace-judge' }, compact: true }));
    expect(screen.queryByTestId('judge-model-not-recorded')).toBeNull();
    // the hint still travels in the tooltip
    expect(screen.getByTestId('judge-model-label').getAttribute('title')).toContain('model not recorded');
  });

  it('bedrock run: a single label, no resolved/hint spans', () => {
    render(React.createElement(JudgeModelLabel, { run: { judgeModelId: 'claude-sonnet-4.6', judgeModel: 'claude-sonnet-4.6' } }));
    expect(screen.getByTestId('judge-model-kind').textContent).toBe('Claude Sonnet 4.6');
    expect(screen.queryByTestId('judge-model-resolved')).toBeNull();
    expect(screen.queryByTestId('judge-model-not-recorded')).toBeNull();
  });

  it('renders an em dash when the run has no judge', () => {
    render(React.createElement(JudgeModelLabel, { run: {} }));
    expect(screen.getByTestId('judge-model-kind').textContent).toBe('—');
  });

  it('judgeModelText mirrors the visible label for sorting/tooltips', () => {
    expect(judgeModelText({ judgeModelId: 'agent-trace-judge', judgeModel: SONNET_45 })).toBe('Agent Trace Judge (pi SDK + query_spans) · claude-sonnet-4-5');
    expect(judgeModelText({ judgeModelId: 'agent-trace-judge' })).toBe('Agent Trace Judge (pi SDK + query_spans)');
    expect(judgeModelText(undefined)).toBe('—');
  });
});
