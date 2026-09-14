/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RTL: the shared JudgeModelSelect labels the "Agent Trace Judge" option with
 * the LLM the server would ACTUALLY judge with (from GET /api/judge/models'
 * `resolvedModel`), e.g. "Agent Trace Judge (pi SDK + query_spans) — Claude
 * Sonnet 4.5 (Global)". Plain provider entries are untouched, and until the
 * catalog fetch resolves (or if it fails) the plain display name renders.
 *
 * Radix Select portals its items and needs pointer events to open, so the
 * ui/select primitives are stubbed with plain DOM elements — what's under
 * test is the label composition and the resolved-model attribute, not Radix.
 */

import * as React from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';

jest.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => React.createElement('div', { 'data-testid': 'select' }, children),
  SelectTrigger: ({ children }: any) => React.createElement('div', null, children),
  SelectValue: () => null,
  SelectContent: ({ children }: any) => React.createElement('div', null, children),
  SelectGroup: ({ children }: any) => React.createElement('div', null, children),
  SelectLabel: ({ children }: any) => React.createElement('div', { 'data-testid': 'group-label' }, children),
  SelectItem: ({ children, value, ...rest }: any) =>
    React.createElement('div', { 'data-testid': `option-${value}`, 'data-resolved-judge-model': rest['data-resolved-judge-model'], title: rest.title }, children),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [],
    models: {
      'claude-sonnet-4.6': { model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock' },
      'agent-trace-judge': { model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent' },
      'pi-judge': { model_id: 'pi-judge', display_name: 'Pi (Judge)', provider: 'pi' },
    },
  },
}));

import { JudgeModelSelect } from '@/components/JudgeModelSelect';

const SONNET_45 = 'amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0';

function mockCatalog(models: any[]) {
  (global as any).fetch = jest.fn(async (url: string) => {
    if (String(url).endsWith('/api/judge/models')) {
      return { ok: true, json: async () => ({ models, total: models.length }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

describe('<JudgeModelSelect /> — resolved model next to "Agent Trace Judge"', () => {
  afterEach(() => { cleanup(); jest.restoreAllMocks(); });

  it('appends " — <resolved model name>" to the agent-judge option once /api/judge/models resolves; other options unchanged', async () => {
    mockCatalog([
      { key: 'claude-sonnet-4.6', model_id: 'us.anthropic.claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', provider: 'bedrock' },
      { key: 'agent-trace-judge', model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent',
        resolvedModel: SONNET_45, resolvedModelName: 'Claude Sonnet 4.5 (Global)', resolvedSource: 'auto', pinEnv: 'AH_AGENT_JUDGE_MODEL_ID' },
      { key: 'pi-judge', model_id: 'pi-judge', display_name: 'Pi (Judge)', provider: 'pi' },
    ]);
    await act(async () => {
      render(React.createElement(JudgeModelSelect, { value: '', onValueChange: () => {}, allowDefault: true }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('option-agent-trace-judge').textContent).toBe('Agent Trace Judge (pi SDK + query_spans) — Claude Sonnet 4.5 (Global)');
    });
    const agentOpt = screen.getByTestId('option-agent-trace-judge');
    expect(agentOpt.getAttribute('data-resolved-judge-model')).toBe(SONNET_45);
    expect(agentOpt.getAttribute('title')).toContain('auto');
    expect(agentOpt.getAttribute('title')).toContain(SONNET_45);
    // plain provider + pi-judge (not annotated by the server) stay as-is
    expect(screen.getByTestId('option-claude-sonnet-4.6').textContent).toBe('Claude Sonnet 4.6');
    expect(screen.getByTestId('option-pi-judge').textContent).toBe('Pi (Judge)');
    expect(screen.getByTestId('option-claude-sonnet-4.6').getAttribute('data-resolved-judge-model')).toBeNull();
  });

  it('falls back to a short id-derived label when the catalog has no display name for the resolved model', async () => {
    mockCatalog([
      { key: 'agent-trace-judge', model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent', resolvedModel: SONNET_45, resolvedSource: 'env-pin' },
    ]);
    await act(async () => {
      render(React.createElement(JudgeModelSelect, { value: '', onValueChange: () => {} }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('option-agent-trace-judge').textContent).toBe('Agent Trace Judge (pi SDK + query_spans) — claude-sonnet-4-5');
    });
  });

  it('renders the plain display name when the catalog is unavailable or reports resolveError (nothing blocks on the pi registry)', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await act(async () => {
      render(React.createElement(JudgeModelSelect, { value: '', onValueChange: () => {} }));
    });
    expect(screen.getByTestId('option-agent-trace-judge').textContent).toBe('Agent Trace Judge (pi SDK + query_spans)');
    cleanup();
    mockCatalog([
      { key: 'agent-trace-judge', model_id: 'agent-trace-judge', display_name: 'Agent Trace Judge (pi SDK + query_spans)', provider: 'agent', resolveError: 'no credentialed model in the pi registry', pinEnv: 'AH_AGENT_JUDGE_MODEL_ID' },
    ]);
    await act(async () => {
      render(React.createElement(JudgeModelSelect, { value: '', onValueChange: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('option-agent-trace-judge').textContent).toBe('Agent Trace Judge (pi SDK + query_spans)');
  });
});
