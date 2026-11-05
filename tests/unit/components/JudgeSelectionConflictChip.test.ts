/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JudgeSelectionConflictChip — renders the amber "body pinned a different
 * judge — run selection applied" notice when a report carries
 * `judgeSelectionConflicts`, and nothing otherwise.
 *
 * Written with React.createElement (not JSX) — this repo's jest config
 * only matches `*.test.ts`.
 */

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { JudgeSelectionConflictChip } from '@/components/JudgeSelectionConflictChip';

describe('JudgeSelectionConflictChip', () => {
  it('renders nothing when there are no conflicts', () => {
    const { container } = render(React.createElement(JudgeSelectionConflictChip, { conflicts: [] }));
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(React.createElement(JudgeSelectionConflictChip, {}));
    expect(c2.firstChild).toBeNull();
  });

  it('renders one row per conflict with the run (applied) and body (ignored) values', () => {
    render(
      React.createElement(JudgeSelectionConflictChip, {
        conflicts: [
          { field: 'evaluatorId', runValue: 'system-rca-default', bodyValue: 'system-factuality' },
          { field: 'modelId', runValue: 'demo-model', bodyValue: 'some-other-model' },
        ],
      }),
    );
    const chip = screen.getByTestId('judge-selection-conflict-chip');
    expect(chip.textContent).toContain('Body pinned a different judge — run selection applied');
    const rows = screen.getAllByTestId('judge-selection-conflict-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('evaluator');
    expect(rows[0].textContent).toContain('system-rca-default');
    expect(rows[0].textContent).toContain('system-factuality');
    expect(rows[1].textContent).toContain('judge model');
    expect(rows[1].textContent).toContain('demo-model');
    expect(rows[1].textContent).toContain('some-other-model');
  });
});
