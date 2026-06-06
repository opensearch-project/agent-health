/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for EvaluatorVersionHistory.
 *
 * Covers the parts of the component that are pure UI logic on top of the
 * versions API:
 *   - Empty/single-version state renders the explanatory empty card.
 *   - Multi-version state renders one row per version, newest first, with
 *     the `latest` badge on the first row and a v{N} count.
 *   - The Compare button enables only when exactly two checkboxes are
 *     selected, and selecting a third drops the oldest selection.
 *   - Clicking Compare opens the diff dialog with the "Comparing vA → vB"
 *     header (older → newer regardless of click order).
 *   - The eye-icon row action opens the read-only view dialog with the
 *     selected version's content.
 *   - System evaluators short-circuit straight to the empty state.
 */

import * as React from 'react';
// React 19 moved `act` and @testing-library/react@16's compat shim still
// reaches for `React.act`. If it's missing (because we're running against
// a slightly older Jest pipeline) fall back to `react-dom/test-utils.act`
// so tests don't blow up on every render() call.
if (!(React as any).act) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  (React as any).act = require('react-dom/test-utils').act;
}
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { EvaluatorVersionHistory } from '@/components/evaluators/EvaluatorVersionHistory';

// ── Test helpers ──────────────────────────────────────────────────────────────

const makeVersion = (n: number, overrides: Partial<any> = {}) => ({
  version: n,
  currentVersion: n,
  createdAt: `2026-06-${String(n).padStart(2, '0')}T10:00:00.000Z`,
  systemPrompt: `prompt v${n}\nline2 v${n}`,
  scoringConfig: { metrics: [{ name: 'accuracy', weight: 1, scale: 100 }], passThreshold: 70 + n, scale: 100 },
  inferenceConfig: { provider: 'bedrock', temperature: 0.1, maxTokens: 4096 },
  ...overrides,
});

/**
 * Replace `global.fetch` with a mock that returns the given versions array
 * for any /versions GET. Returns the spy so individual tests can assert on call args.
 */
function mockVersionsFetch(versions: any[]) {
  const spy = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ versions, total: versions.length }),
  });
  // @ts-expect-error - jsdom global fetch shim
  global.fetch = spy;
  return spy;
}

// JSDOM doesn't implement scrollIntoView; the History card doesn't use it
// directly but Radix Dialog does. Stub it so opens don't throw.
beforeAll(() => {
  // @ts-expect-error - test shim
  Element.prototype.scrollIntoView = jest.fn();
  // Radix Dialog uses these and JSDOM doesn't ship them.
  // @ts-expect-error - test shim
  Element.prototype.hasPointerCapture = jest.fn(() => false);
  // @ts-expect-error - test shim
  Element.prototype.releasePointerCapture = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('EvaluatorVersionHistory', () => {
  it('renders the single-version empty state for an evaluator with only v1', async () => {
    mockVersionsFetch([makeVersion(1)]);

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "eval-only-v1" }));

    await waitFor(() =>
      expect(screen.getByText(/no prior versions yet/i)).toBeTruthy(),
    );
    // No version table rendered when we don't have at least 2 versions.
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('short-circuits to the immutability copy for system evaluators', async () => {
    mockVersionsFetch([makeVersion(1)]);

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "system-rca-default", isSystem: true }));

    await waitFor(() =>
      expect(
        screen.getByText(/system evaluators are immutable/i),
      ).toBeTruthy(),
    );
  });

  it('renders one row per version newest-first with a "latest" badge on row 0', async () => {
    mockVersionsFetch([makeVersion(3), makeVersion(2), makeVersion(1)]);

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "eval-multi" }));

    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());

    const rows = screen.getAllByRole('row');
    // 1 header row + 3 data rows
    expect(rows).toHaveLength(4);

    // Rendered top-to-bottom in v3, v2, v1 order.
    expect(within(rows[1]).getByText('v3')).toBeTruthy();
    expect(within(rows[1]).getByText(/latest/i)).toBeTruthy();
    expect(within(rows[2]).getByText('v2')).toBeTruthy();
    expect(within(rows[3]).getByText('v1')).toBeTruthy();

    // Legacy row 1 should NOT also have a "latest" badge.
    expect(within(rows[2]).queryByText(/latest/i)).toBeNull();
  });

  it('Compare button enables only with exactly two selections and caps at two', async () => {
    mockVersionsFetch([makeVersion(3), makeVersion(2), makeVersion(1)]);

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "eval-cap" }));

    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());

    const compare = screen.getByRole('button', { name: /^Compare \(0\/2\)$/i });
    expect(compare).toHaveProperty('disabled', true);

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(3);

    fireEvent.click(checkboxes[0]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Compare \(1\/2\)$/i }),
      ).toHaveProperty('disabled', true),
    );

    fireEvent.click(checkboxes[1]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Compare \(2\/2\)$/i }),
      ).toHaveProperty('disabled', false),
    );

    // Adding a third selection drops the oldest selection (FIFO),
    // staying at 2/2 and remaining enabled.
    fireEvent.click(checkboxes[2]);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Compare \(2\/2\)$/i }),
      ).toHaveProperty('disabled', false),
    );
  });

  it('Compare opens the diff dialog with "Comparing vOLDER → vNEWER" regardless of click order', async () => {
    mockVersionsFetch([makeVersion(3), makeVersion(2), makeVersion(1)]);

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "eval-diff" }));

    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());

    const checkboxes = screen.getAllByRole('checkbox');
    // Click newest then oldest on purpose — the title should still be
    // older → newer because diffs read most naturally that way.
    fireEvent.click(checkboxes[0]); // v3 (newest)
    fireEvent.click(checkboxes[2]); // v1 (oldest)
    fireEvent.click(screen.getByRole('button', { name: /^Compare \(2\/2\)$/i }));

    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/Comparing v1 → v3/i)).toBeTruthy();
    });
  });

  it('Eye icon opens the single-version read-only view dialog', async () => {
    mockVersionsFetch([makeVersion(2), makeVersion(1)]);

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "eval-view" }));

    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());

    const eyeButtons = screen.getAllByRole('button', { name: /view this version/i });
    expect(eyeButtons).toHaveLength(2);

    fireEvent.click(eyeButtons[0]); // open the latest version's view dialog

    await waitFor(() => {
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/Version v2/i)).toBeTruthy();
      expect(within(dialog).getByText(/prompt v2/)).toBeTruthy();
    });
  });

  it('shows an error state with a Retry button when the API call fails', async () => {
    const spy = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: 'boom' }),
    });
    // @ts-expect-error - jsdom global fetch shim
    global.fetch = spy;

    render(React.createElement(EvaluatorVersionHistory, { evaluatorId: "eval-err" }));

    await waitFor(() =>
      expect(screen.getByText(/failed to load versions/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});
