/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for SettingsPage test-connection handlers.
 *
 * Regression tests for: calling response.json() on an empty/non-JSON response body
 * (e.g. when the Vite dev proxy returns a 502 with no body because the backend is down).
 * Before the fix, this surfaced the raw browser SyntaxError in the UI:
 *   "Failed to execute 'json' on 'Response': Unexpected end of JSON input"
 * After the fix, a clear, actionable message is shown instead.
 */

import * as React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SettingsPage } from '@/components/SettingsPage';

// ── Dependency mocks ──────────────────────────────────────────────────────────

jest.mock('@/services/storage/opensearchClient', () => ({
  storageAdmin: {
    health: jest.fn().mockResolvedValue({ status: 'ok' }),
    stats: jest.fn().mockResolvedValue({ stats: {} }),
  },
}));

jest.mock('@/services/storage', () => ({
  hasLocalStorageData: jest.fn().mockReturnValue(false),
  getLocalStorageCounts: jest.fn().mockReturnValue({ testCases: 0, experiments: 0, reports: 0 }),
  migrateToOpenSearch: jest.fn(),
  exportLocalStorageData: jest.fn(),
  clearLocalStorageData: jest.fn(),
}));

jest.mock('@/lib/dataSourceConfig', () => ({
  getConfigStatus: jest.fn().mockResolvedValue({
    storage: { configured: false, source: 'none' },
    observability: { configured: false, source: 'none' },
  }),
  saveStorageConfig: jest.fn().mockResolvedValue(undefined),
  saveObservabilityConfig: jest.fn().mockResolvedValue(undefined),
  clearStorageConfig: jest.fn().mockResolvedValue(undefined),
  clearObservabilityConfig: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/constants', () => ({
  DEFAULT_CONFIG: {
    agents: [
      {
        key: 'demo',
        name: 'Demo Agent',
        endpoint: 'http://localhost:3000',
        models: ['claude-sonnet-4'],
        useTraces: false,
        isCustom: false,
      },
    ],
    models: {},
  },
  refreshConfig: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/lib/theme', () => ({
  getTheme: jest.fn().mockReturnValue('dark'),
  setTheme: jest.fn(),
}));

jest.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/settings', hash: '', search: '', state: null }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A fetch mock that returns a response whose .json() throws SyntaxError (empty body). */
function emptyBodyResponse(status = 502) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
  };
}

/** A fetch mock that returns a successful JSON connection result. */
function successResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'ok', clusterName: 'my-cluster', clusterStatus: 'green' }),
  };
}

/** A fetch mock that returns a JSON connection failure result. */
function connectionFailedResponse(message = 'Connection refused') {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'error', message }),
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: mock the /api/debug GET called on mount
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ enabled: false }),
  });
});

async function renderAndWait() {
  await act(async () => {
    render(React.createElement(SettingsPage));
  });
  await waitFor(() => expect(screen.getByTestId('settings-page')).not.toBeNull());
}

// ── Storage test-connection ───────────────────────────────────────────────────

describe('handleTestStorageConnection', () => {
  it('shows a helpful error message when the server returns an empty body', async () => {
    await renderAndWait();

    const input = document.getElementById('storage-endpoint') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://opensearch.example.com' } });

    (global.fetch as jest.Mock).mockResolvedValueOnce(emptyBodyResponse(502));

    fireEvent.click(screen.getAllByText('Test Connection')[0]);

    await waitFor(() => {
      expect(screen.queryByText(/backend returned an invalid response \(HTTP 502\)/i)).not.toBeNull();
    });
  });

  it('shows success message when connection is ok', async () => {
    await renderAndWait();

    const input = document.getElementById('storage-endpoint') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://opensearch.example.com' } });

    (global.fetch as jest.Mock).mockResolvedValueOnce(successResponse());

    fireEvent.click(screen.getAllByText('Test Connection')[0]);

    await waitFor(() => {
      expect(screen.queryByText(/connected to my-cluster/i)).not.toBeNull();
    });
  });

  it('shows the server error message when the cluster is unreachable', async () => {
    await renderAndWait();

    const input = document.getElementById('storage-endpoint') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://opensearch.example.com' } });

    (global.fetch as jest.Mock).mockResolvedValueOnce(connectionFailedResponse('getaddrinfo ENOTFOUND'));

    fireEvent.click(screen.getAllByText('Test Connection')[0]);

    await waitFor(() => {
      expect(screen.queryByText(/getaddrinfo ENOTFOUND/i)).not.toBeNull();
    });
  });

  it('button is disabled when endpoint is empty', async () => {
    await renderAndWait();

    // Button should be disabled when no endpoint is entered
    const buttons = screen.getAllByText('Test Connection');
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── Observability test-connection ─────────────────────────────────────────────

describe('handleTestObservabilityConnection', () => {
  it('shows a helpful error message when the server returns an empty body', async () => {
    await renderAndWait();

    const input = document.getElementById('obs-endpoint') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://logs.example.com' } });

    (global.fetch as jest.Mock).mockResolvedValueOnce(emptyBodyResponse(502));

    fireEvent.click(screen.getAllByText('Test Connection')[1]);

    await waitFor(() => {
      expect(screen.queryByText(/backend returned an invalid response \(HTTP 502\)/i)).not.toBeNull();
    });
  });

  it('shows success message with index warning when connection is ok', async () => {
    await renderAndWait();

    const input = document.getElementById('obs-endpoint') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://logs.example.com' } });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          status: 'ok',
          clusterName: 'logs-cluster',
          clusterStatus: 'yellow',
          message: 'No matching indices found',
        }),
    });

    fireEvent.click(screen.getAllByText('Test Connection')[1]);

    await waitFor(() => {
      expect(screen.queryByText(/connected to logs-cluster/i)).not.toBeNull();
      expect(screen.queryByText(/no matching indices found/i)).not.toBeNull();
    });
  });

  it('shows the server error message when the cluster is unreachable', async () => {
    await renderAndWait();

    const input = document.getElementById('obs-endpoint') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://logs.example.com' } });

    (global.fetch as jest.Mock).mockResolvedValueOnce(connectionFailedResponse('ECONNREFUSED'));

    fireEvent.click(screen.getAllByText('Test Connection')[1]);

    await waitFor(() => {
      expect(screen.queryByText(/ECONNREFUSED/i)).not.toBeNull();
    });
  });

  it('shows validation error when endpoint is empty', async () => {
    await renderAndWait();

    // Button should be disabled when no endpoint is entered
    const buttons = screen.getAllByText('Test Connection');
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
  });
});
