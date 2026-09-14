/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BenchmarkCasesTab } from '@/components/evals3/BenchmarkCasesTab';
import { DescribeGroupFilter, UNGROUPED } from '@/components/evals3/DescribeGroupFilter';
import { DescribePathChain } from '@/components/evals3/DescribePathChain';
import { groupCasesByDescribe } from '@/lib/describeGroups';
import type { TestCase } from '@/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => React.createElement('div', null, children),
}));

function tc(id: string, name: string, describePath?: string[]): TestCase {
  return {
    id, name, labels: [], category: 'RCA', difficulty: 'Easy', currentVersion: 1, versions: [],
    isPromoted: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    initialPrompt: `prompt ${name}`, context: [], sourceFile: 'evals/demo.eval.mjs',
    ...(describePath !== undefined ? { describePath } : {}),
  } as unknown as TestCase;
}

const grouped: TestCase[] = [
  tc('a1', 'alpha one', ['Suite Alpha', 'Inner']),
  tc('a2', 'alpha two', ['Suite Alpha']),
  tc('b1', 'beta one', ['Suite Beta']),
  tc('legacy', 'legacy case'),          // imported before describePath existed
  tc('top', 'top-level case', []),      // code test outside any describe
];

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
      addListener: jest.fn(), removeListener: jest.fn(), dispatchEvent: jest.fn(),
    })),
  });
  (globalThis as any).CSS ??= {};
  (globalThis as any).CSS.escape = (value: string) => value;
});

function renderTab(testCases: TestCase[], selectedCaseId?: string) {
  return render(React.createElement(
    MemoryRouter, null,
    React.createElement(BenchmarkCasesTab, {
      benchmarkId: 'bench', testCases, recentRuns: [], allRuns: [], totalRuns: 0, reportsById: {},
      selectedCaseId, onSelectCase: jest.fn(), onClearCase: jest.fn(), onOpenRuns: jest.fn(),
    }),
  ));
}

describe('DescribePathChain', () => {
  it('renders the chain outermost-first', () => {
    render(React.createElement(DescribePathChain, { testCase: { describePath: ['Suite', 'Inner'] } }));
    const segments = screen.getAllByTestId('describe-path-segment').map(el => el.textContent);
    expect(segments).toEqual(['Suite', 'Inner']);
    expect(screen.getByTestId('describe-path-chain').getAttribute('aria-label')).toBe('Describe chain: Suite > Inner');
  });

  it('renders nothing for legacy / top-level / malformed cases — never the string "undefined"', () => {
    for (const describePath of [undefined, [], 'Suite' as unknown as string[], [1] as unknown as string[]]) {
      const { container, unmount } = render(React.createElement(DescribePathChain, { testCase: { describePath } }));
      expect(container.textContent).toBe('');
      expect(container.textContent).not.toContain('undefined');
      unmount();
    }
  });
});

describe('DescribeGroupFilter', () => {
  it('renders nothing when no case carries a describe chain', () => {
    const { container } = render(React.createElement(DescribeGroupFilter, {
      grouping: groupCasesByDescribe([tc('x', 'x'), tc('y', 'y', [])]), selected: null, onSelect: jest.fn(),
    }));
    expect(container.querySelector('[data-testid="describe-groups"]')).toBeNull();
  });

  it('is collapsed by default, lists each outermost describe with counts plus an Ungrouped row, and toggles selection', () => {
    const onSelect = jest.fn();
    render(React.createElement(DescribeGroupFilter, { grouping: groupCasesByDescribe(grouped), selected: null, onSelect }));
    const details = screen.getByTestId('describe-groups') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByTestId('describe-groups-count').textContent).toBe('2 suites');

    const groups = screen.getAllByTestId('describe-group');
    expect(groups.map(g => g.getAttribute('data-describe-title'))).toEqual(['Suite Alpha', 'Suite Beta']);
    expect(groups.map(g => within(g).getByTestId('describe-group-count').textContent)).toEqual(['2', '1']);
    expect(within(screen.getByTestId('describe-group-ungrouped')).getByTestId('describe-group-count').textContent).toBe('2');
    expect(screen.queryByText('undefined')).toBeNull();

    fireEvent.click(groups[0]);
    expect(onSelect).toHaveBeenCalledWith('Suite Alpha');
    fireEvent.click(screen.getByTestId('describe-group-ungrouped'));
    expect(onSelect).toHaveBeenCalledWith(UNGROUPED);
  });

  it('shows the active suite in the summary with a clear button; clicking a selected group deselects it', () => {
    const onSelect = jest.fn();
    render(React.createElement(DescribeGroupFilter, { grouping: groupCasesByDescribe(grouped), selected: 'Suite Beta', onSelect }));
    expect((screen.getByTestId('describe-groups').querySelector('summary') as HTMLElement).textContent).toContain('Suite: Suite Beta');
    fireEvent.click(screen.getByTestId('describe-groups-clear'));
    expect(onSelect).toHaveBeenCalledWith(null);
    fireEvent.click(screen.getAllByTestId('describe-group')[1]);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('BenchmarkCasesTab — group by describe', () => {
  it('narrows the case list to the picked suite and back; legacy cases stay listed (ungrouped) when no suite is picked', () => {
    renderTab(grouped);
    const list = screen.getByRole('listbox', { name: 'Benchmark cases' });
    expect(within(list).getAllByRole('option')).toHaveLength(5);

    fireEvent.click(screen.getAllByTestId('describe-group')[0]); // Suite Alpha
    expect(within(list).getAllByRole('option').map(o => o.getAttribute('data-case-id')).sort()).toEqual(['a1', 'a2']);
    expect(screen.getByText(/^2 shown/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('describe-group-ungrouped'));
    expect(within(list).getAllByRole('option').map(o => o.getAttribute('data-case-id')).sort()).toEqual(['legacy', 'top']);

    fireEvent.click(screen.getByTestId('describe-groups-clear'));
    expect(within(list).getAllByRole('option')).toHaveLength(5);
  });

  it('shows the selected case\'s describe chain in the detail header, and no chain for a legacy case', () => {
    const { unmount } = renderTab(grouped, 'a1');
    expect(screen.getAllByTestId('describe-path-segment').map(s => s.textContent)).toEqual(['Suite Alpha', 'Inner']);
    unmount();
    renderTab(grouped, 'legacy');
    expect(screen.queryByTestId('describe-path-chain')).toBeNull();
  });

  it('renders no grouping affordance at all for a benchmark of legacy cases', () => {
    renderTab([tc('x', 'x'), tc('y', 'y')]);
    expect(screen.queryByTestId('describe-groups')).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Benchmark cases' }).textContent).not.toContain('undefined');
  });
});
