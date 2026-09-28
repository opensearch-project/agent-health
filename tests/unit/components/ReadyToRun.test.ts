/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReadyToRun } from '@/components/dashboard/ReadyToRun';

describe('ReadyToRun', () => {
  it('points users with definitions at running a benchmark', () => {
    render(React.createElement(
      MemoryRouter,
      null,
      React.createElement(ReadyToRun),
    ));

    expect(screen.getByTestId('ready-to-run')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ready to run' })).toBeTruthy();
    expect(screen.getByText(/definitions are imported/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /run a benchmark/i }).getAttribute('href')).toBe('/evaluations/benchmarks');
    expect(screen.queryByTestId('first-run-experience')).toBeNull();
    expect(screen.queryByTestId('dashboard-page')).toBeNull();
  });
});
