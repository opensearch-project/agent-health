/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `cancelled` result status (run-status-integrity fix, 2026-09-04): a
 * planned case the run never reached is written as
 * `results[tc] = { reportId: '', status: 'cancelled' }` at finalization. It
 * must render as "NOT RUN" (neutral), never as FAILED (it didn't fail — it
 * never ran) and never as a pending/spinner state (it never will run).
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getResultStatus, StatusIcon, StatusLabel, getStatusDescription } from '@/components/evals3/ResultStatus';

describe('ResultStatus — cancelled (never started) cases', () => {
  it('getResultStatus maps a cancelled result to `cancelled`, not `failed`, regardless of report', () => {
    expect(getResultStatus({ status: 'cancelled' }, null)).toBe('cancelled');
    expect(getResultStatus({ status: 'cancelled' }, { passFailStatus: 'passed' } as any)).toBe('cancelled');
    // Sanity: real failures still map to failed.
    expect(getResultStatus({ status: 'failed' }, null)).toBe('failed');
  });

  it('renders a neutral NOT RUN label and a non-spinning icon', () => {
    const label = renderToStaticMarkup(React.createElement(StatusLabel, { status: 'cancelled' }));
    expect(label).toContain('NOT RUN');
    expect(label).not.toContain('FAILED');
    const icon = renderToStaticMarkup(React.createElement(StatusIcon, { status: 'cancelled' }));
    expect(icon).not.toContain('animate-spin');
    expect(icon).toContain('text-muted-foreground');
  });

  it('describes the state as not run because of cancellation', () => {
    expect(getStatusDescription('cancelled')).toMatch(/not run/i);
    expect(getStatusDescription('cancelled')).toMatch(/cancelled/i);
  });
});
