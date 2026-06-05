/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the redesigned EvaluatorEditPage.
 *
 * Covers behaviours introduced by the wide-screen redesign:
 *   - Sticky header renders title + Cancel + Save in their new layout
 *   - System evaluators show a Lock badge, hide Save, and disable inputs
 *   - System Prompt char + line counter updates as the user types
 *   - Add / Remove metric controls work
 *   - Save uses POST for new + navigates back, PUT for edit + stays
 *   - Validation errors prevent network calls
 *
 * EvaluatorVersionHistory is mocked so we don't need to drive the
 * dialog/version table in a unit test.
 */

import * as React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import type { Evaluator } from '@/types';

// ── Router mocks ─────────────────────────────────────────────────────────────

const mockNavigate = jest.fn();
const mockUseParams = jest.fn(() => ({ evaluatorId: undefined as string | undefined }));
// EvaluatorEditPage derives isViewRoute from location.pathname:
//   isViewRoute = isEditMode && !/\/edit\/?$/.test(pathname)
// so the pathname controls whether an existing evaluator renders in "Edit"
// vs "View" mode. Tests set this per describe-block (default: an /edit path
// so the custom-evaluator edit flow shows the editable form + "Edit" title).
let mockPathname = '/evaluators/x/edit';
// The History pane (EvaluatorVersionHistory) only mounts when the active tab
// is "history", which the component seeds from location.hash === '#history'.
// Tests that assert on the version-history panel set this to '#history'.
let mockHash = '';

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => mockUseParams(),
  // EvaluatorEditPage transitively renders useClusterContext, which calls
  // useSearchParams + useLocation; without them the hook throws "… is not a
  // function".
  useSearchParams: () => [new URLSearchParams(), jest.fn()],
  useLocation: () => ({ pathname: mockPathname, search: '', hash: mockHash, state: null, key: 'test' }),
}));

// ── Version history (avoids fetching versions in unit tests) ─────────────────

jest.mock('@/components/evaluators/EvaluatorVersionHistory', () => ({
  EvaluatorVersionHistory: ({
    evaluatorId,
    refreshKey,
  }: {
    evaluatorId: string;
    refreshKey?: number;
  }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'mock-version-history',
        'data-evaluator-id': evaluatorId,
        'data-refresh-key': String(refreshKey ?? 0),
      },
      'mock-version-history',
    ),
}));

// Suppress noisy alert() calls used for inline validation feedback.
const originalAlert = global.alert;

// Pull the component in *after* the mocks are registered.
// Importing lazily inside `beforeAll` works around ts-jest hoisting rules.
let EvaluatorEditPage: React.FC;

beforeAll(async () => {
  ({ EvaluatorEditPage } = await import('@/components/EvaluatorEditPage'));
});

beforeEach(() => {
  mockNavigate.mockReset();
  mockUseParams.mockReturnValue({ evaluatorId: undefined });
  // Default to an /edit path so an existing evaluator renders the editable
  // form (isViewRoute=false). View/system blocks override this below.
  mockPathname = '/evaluators/x/edit';
  mockHash = '';
  global.alert = jest.fn();
  global.fetch = jest.fn();
});

afterEach(() => {
  global.alert = originalAlert;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const customEvaluator: Evaluator = {
  id: 'eval-test-1',
  name: 'RCA Correctness',
  description: 'Evaluates RCA agents on routing accuracy.',
  isSystem: false,
  systemPrompt:
    '- If the issue\'s CTI Type is "Data Plane" -> route correctly\n- DP1: Search\n- DP2: Node Drop',
  scoringConfig: {
    metrics: [
      { name: 'accuracy', description: 'Overall accuracy', weight: 1.0, scale: 100 },
    ],
    passThreshold: 70,
    scale: 100,
  },
  inferenceConfig: {
    provider: 'bedrock' as any,
    modelId: 'anthropic.claude-3',
    temperature: 0.1,
    maxTokens: 4096,
  },
  currentVersion: 1,
  versions: [],
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

const systemEvaluator: Evaluator = {
  ...customEvaluator,
  id: 'system-eval-1',
  name: 'Built-in Faithfulness',
  isSystem: true,
};

const mockFetchOk = (data: unknown) =>
  ({
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue(data),
  }) as unknown as Response;

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EvaluatorEditPage — new evaluator (create mode)', () => {
  it('renders the sticky header with title, Cancel, and Save', async () => {
    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    expect(screen.getByRole('heading', { name: /new evaluator/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /save/i })).toBeTruthy();
  });

  it('updates the System Prompt counter as the user types', async () => {
    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    // Find the prompt textarea (placeholder identifies it uniquely)
    const promptArea = screen.getByPlaceholderText(/expert evaluator/i) as HTMLTextAreaElement;

    const value = 'line one\nline two\nline three';
    await act(async () => {
      fireEvent.change(promptArea, { target: { value } });
    });

    // Counter renders both lines and chars; assert against the actual length.
    expect(screen.getByText(/3 lines/i)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${value.length}\\s*chars`, 'i'))).toBeTruthy();
  });

  it('blocks Save and shows validation when name is empty', async () => {
    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    expect(global.alert).toHaveBeenCalledWith('Name is required');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('blocks Save when system prompt is empty', async () => {
    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    fireEvent.change(screen.getByPlaceholderText(/factuality checker/i), {
      target: { value: 'My Evaluator' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    expect(global.alert).toHaveBeenCalledWith('System prompt is required');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs the payload and navigates back on successful create', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockFetchOk({ id: 'eval-new-1', currentVersion: 1 }),
    );

    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    fireEvent.change(screen.getByPlaceholderText(/factuality checker/i), {
      target: { value: 'Brand New Eval' },
    });
    fireEvent.change(screen.getByPlaceholderText(/expert evaluator/i), {
      target: { value: 'You are a judge.' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toMatch(/\/api\/storage\/evaluators$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.name).toBe('Brand New Eval');
    expect(body.systemPrompt).toBe('You are a judge.');
    expect(body.scoringConfig.metrics).toHaveLength(1);
    expect(body.scoringConfig.passThreshold).toBe(70);

    // After create, the page navigates to the new evaluator's view page
    // (not the list) so the user lands on what they just made — the
    // view-after-save UX. The created id comes from the POST response.
    expect(mockNavigate).toHaveBeenCalledWith('/evaluators/eval-new-1');
  });
});

describe('EvaluatorEditPage — metrics editor', () => {
  it('Add Metric appends a row, Remove deletes one', async () => {
    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    // Default: 1 metric → no remove button visible (length === 1 hides it)
    expect(screen.queryByRole('button', { name: /remove metric/i })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /add metric/i }));
    });

    // Now we should have 2 metric rows → remove buttons appear
    const removeButtons = screen.getAllByRole('button', { name: /remove metric/i });
    expect(removeButtons.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      fireEvent.click(removeButtons[1]);
    });

    expect(screen.queryByRole('button', { name: /remove metric/i })).toBeNull();
  });
});

describe('EvaluatorEditPage — edit existing custom evaluator', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ evaluatorId: customEvaluator.id });
  });

  it('loads existing evaluator data in edit mode and PUTs to its own page (not the list)', async () => {
    // Edit mode (/edit path) pins the Tabs value to "latest" regardless of
    // hash — version history is a view-route-only surface, so the History
    // pane is intentionally not reachable here. This test covers the editable
    // form + update flow; view-mode history is covered separately.
    (global.fetch as jest.Mock)
      // initial GET
      .mockResolvedValueOnce(mockFetchOk(customEvaluator))
      // PUT
      .mockResolvedValueOnce(mockFetchOk({ ...customEvaluator, currentVersion: 2 }));

    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    // Title reads "Edit Evaluator" for an editable custom evaluator.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /edit evaluator/i })).toBeTruthy();
    });

    // Existing values populated into the form.
    expect((screen.getByDisplayValue('RCA Correctness') as HTMLInputElement).value).toBe(
      'RCA Correctness',
    );

    // History pane is NOT mounted in edit mode (view-route-only surface).
    expect(screen.queryByTestId('mock-version-history')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /save/i }));
    });

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    const putCall = (global.fetch as jest.Mock).mock.calls[1];
    expect(putCall[0]).toMatch(new RegExp(`/api/storage/evaluators/${customEvaluator.id}$`));
    expect(putCall[1].method).toBe('PUT');

    // After a successful edit-PUT the user lands on the evaluator's own view
    // page (so they can verify the change) — never back on the list.
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(`/evaluators/${customEvaluator.id}`, { replace: true });
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/evaluators');
  });

  it('renders the version-history panel on the view route', async () => {
    // View route (no /edit suffix) + a custom evaluator with ≥2 versions:
    // the History tab is enabled and, when active, mounts
    // EvaluatorVersionHistory wired to this evaluator's id.
    mockPathname = `/evaluators/${customEvaluator.id}`;
    mockHash = '#history';
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      mockFetchOk({ ...customEvaluator, currentVersion: 2 }),
    );

    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    await waitFor(() => {
      const history = screen.getByTestId('mock-version-history');
      expect(history.getAttribute('data-evaluator-id')).toBe(customEvaluator.id);
    });
  });
});

describe('EvaluatorEditPage — system evaluator (read-only)', () => {
  beforeEach(() => {
    mockUseParams.mockReturnValue({ evaluatorId: systemEvaluator.id });
  });

  it('shows the Lock badge, hides Save, and disables inputs', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(mockFetchOk(systemEvaluator));

    await act(async () => {
      render(React.createElement(EvaluatorEditPage));
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /view evaluator/i })).toBeTruthy();
    });

    // Lock badge
    expect(screen.getByText(/system \(read-only\)/i)).toBeTruthy();

    // No Save button — only Cancel
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();

    // Read-only banner under header
    expect(
      screen.getByText(/system evaluators are immutable/i),
    ).toBeTruthy();

    // Name input is disabled
    const nameInput = screen.getByDisplayValue(systemEvaluator.name) as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);

    // Add Metric button is hidden for system evaluators
    expect(screen.queryByRole('button', { name: /add metric/i })).toBeNull();
  });
});
