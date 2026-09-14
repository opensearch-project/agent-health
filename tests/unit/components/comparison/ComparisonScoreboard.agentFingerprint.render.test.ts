/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render tests for the agent-configuration provenance surface on the
 * ComparisonScoreboard (lib/agentFingerprint.ts):
 *
 *   - each row shows its mono fingerprint chip when the run carries one;
 *   - the amber "config changed between runs" badge appears ONCE (row A)
 *     when both rows are the SAME agent with DIFFERENT fingerprints, and
 *     its tooltip says whether the prompt or other fields differ;
 *   - no badge for different agents, identical fingerprints, or a legacy
 *     run on either side;
 *   - the condensed band carries the same badge so it isn't lost on scroll.
 */

import * as React from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ComparisonScoreboard } from '@/components/comparison/ComparisonScoreboard';
import type { RunAggregateMetrics, BenchmarkRun } from '@/types';
import type { TestCaseOverlap } from '@/services/comparisonService';

type IOCallback = (entries: Array<{ isIntersecting: boolean }>) => void;
let ioCallback: IOCallback = () => {};
class MockIntersectionObserver {
  constructor(cb: IOCallback) { ioCallback = cb; }
  observe() {}
  disconnect() {}
}
(global as any).IntersectionObserver = MockIntersectionObserver;

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const PH_1 = '1'.repeat(64);
const PH_2 = '2'.repeat(64);

function makeRun(overrides: Partial<RunAggregateMetrics> = {}): RunAggregateMetrics {
  return {
    runId: 'run-a', runName: 'Run A', createdAt: '2024-01-01T00:00:00Z', modelId: 'claude-3', agentKey: 'agent-x',
    totalTestCases: 10, passedCount: 8, failedCount: 2, passRatePercent: 80,
    ...overrides,
  } as RunAggregateMetrics;
}

const overlap: TestCaseOverlap = { runCount: 2, totalTestCases: 10, sharedTestCases: 10, partialTestCases: 0, perRun: [], fullyOverlapping: true };
const selectedRuns = [{ id: 'run-a', results: {} }, { id: 'run-b', results: {} }] as unknown as BenchmarkRun[];

function renderScoreboard(runs: RunAggregateMetrics[]) {
  return render(
    React.createElement(MemoryRouter, null,
      React.createElement(ComparisonScoreboard, {
        runs, selectedRuns, overlap, onRemoveRun: jest.fn(), onSwapRuns: jest.fn(), getAgentName: (k: string) => k,
      })),
  );
}

describe('ComparisonScoreboard — agent-config provenance', () => {
  it('shows a mono fingerprint chip per row and the "config changed between runs · prompt" badge on row A for the same agent', () => {
    const a = makeRun({ agentFingerprint: FP_A, agentFingerprintShort: 'aaaaaaaaaaaa', agentPromptHash: PH_1 });
    const b = makeRun({ runId: 'run-b', runName: 'Run B', agentFingerprint: FP_B, agentFingerprintShort: 'bbbbbbbbbbbb', agentPromptHash: PH_2 });
    renderScoreboard([a, b]);

    expect(screen.getByTestId('scoreboard-fingerprint-run-a').textContent).toContain('aaaaaaaaaaaa');
    expect(screen.getByTestId('scoreboard-fingerprint-run-b').textContent).toContain('bbbbbbbbbbbb');

    const badge = screen.getByTestId('scoreboard-config-changed-badge');
    expect(badge.textContent).toContain('config changed between runs');
    expect(badge.getAttribute('data-diff-kind')).toBe('prompt');
    expect(badge.getAttribute('title')).toContain('system prompt changed');
    expect(badge.getAttribute('title')).toContain(`A: ${FP_A}`);
    expect(badge.getAttribute('title')).toContain(`B: ${FP_B}`);
    // Row B never duplicates the badge.
    expect(screen.getAllByTestId('scoreboard-config-changed-badge')).toHaveLength(1);
  });

  it('"other fields" wording when prompts match but the connector config differs', () => {
    const a = makeRun({ agentFingerprint: FP_A, agentPromptHash: PH_1 });
    const b = makeRun({ runId: 'run-b', agentFingerprint: FP_B, agentPromptHash: PH_1 });
    renderScoreboard([a, b]);
    const badge = screen.getByTestId('scoreboard-config-changed-badge');
    expect(badge.getAttribute('data-diff-kind')).toBe('other');
    expect(badge.getAttribute('title')).toContain('prompt unchanged');
  });

  it('no badge when fingerprints are identical', () => {
    renderScoreboard([
      makeRun({ agentFingerprint: FP_A, agentPromptHash: PH_1 }),
      makeRun({ runId: 'run-b', agentFingerprint: FP_A, agentPromptHash: PH_1 }),
    ]);
    expect(screen.queryByTestId('scoreboard-config-changed-badge')).toBeNull();
    expect(screen.getByTestId('scoreboard-fingerprint-run-a')).toBeTruthy();
  });

  it('no badge for two DIFFERENT agents even with different fingerprints', () => {
    renderScoreboard([
      makeRun({ agentKey: 'agent-x', agentFingerprint: FP_A, agentPromptHash: PH_1 }),
      makeRun({ runId: 'run-b', agentKey: 'agent-y', agentFingerprint: FP_B, agentPromptHash: PH_2 }),
    ]);
    expect(screen.queryByTestId('scoreboard-config-changed-badge')).toBeNull();
  });

  it('legacy runs (no fingerprint) render neither chip nor badge', () => {
    renderScoreboard([makeRun(), makeRun({ runId: 'run-b' })]);
    expect(screen.queryByTestId('scoreboard-fingerprint-run-a')).toBeNull();
    expect(screen.queryByTestId('scoreboard-fingerprint-run-b')).toBeNull();
    expect(screen.queryByTestId('scoreboard-config-changed-badge')).toBeNull();
  });

  it('one legacy side → chip on the fingerprinted row only, no badge (unknown is not a warning)', () => {
    renderScoreboard([makeRun({ agentFingerprint: FP_A }), makeRun({ runId: 'run-b' })]);
    expect(screen.getByTestId('scoreboard-fingerprint-run-a')).toBeTruthy();
    expect(screen.queryByTestId('scoreboard-fingerprint-run-b')).toBeNull();
    expect(screen.queryByTestId('scoreboard-config-changed-badge')).toBeNull();
  });

  it('the condensed band keeps the mismatch badge visible after scrolling past the band', () => {
    renderScoreboard([
      makeRun({ agentFingerprint: FP_A, agentPromptHash: PH_1 }),
      makeRun({ runId: 'run-b', agentFingerprint: FP_B, agentPromptHash: PH_2 }),
    ]);
    act(() => { ioCallback([{ isIntersecting: false }]); });
    expect(screen.getByTestId('scoreboard-condensed')).toBeTruthy();
    expect(screen.getByTestId('scoreboard-condensed-config-changed-badge').textContent).toContain('config changed between runs');
  });
});
