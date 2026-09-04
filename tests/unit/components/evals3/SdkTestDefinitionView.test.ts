/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for SdkTestDefinitionView — the per-test definition surface for
 * code-SDK test cases (run report "Test Case Definition" + Test Case page).
 *
 *  - Captured record: filename header + [Pretty | Evaluate function | Whole
 *    file] segments, Pretty by default showing THIS test's options (prompt,
 *    expected outcomes, labels, timeout) and NOT other tests from the file.
 *  - Evaluate function segment shows `definition.bodySource`, highlighted.
 *  - Whole file segment shows the pre-existing EvalSourceCodeView.
 *  - Legacy record (no `definition`): whole-file view + re-import hint, no
 *    segments.
 *  - JSON test case (no sourceFile): renders nothing.
 *
 * Written with React.createElement (not JSX) — this repo's jest config only
 * matches `*.test.ts`.
 */

import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) =>
    require('react').createElement('div', null, children),
  hasRealMarkdown: () => false,
}));

import { SdkTestDefinitionView } from '@/components/evals3/SdkTestDefinitionView';
import type { TestCase } from '@/types';

const h = React.createElement;

const WHOLE_FILE = [
  "const { test } = require('@opensearch-project/agent-health');",
  "test('first-case', { prompt: 'Prompt one' }, async ({ result }) => { check(result, 1); });",
  "test('second-case', { prompt: 'Prompt two' }, async ({ result }) => { check(result, 2); });",
  "test('third-case', { prompt: 'Prompt three' }, async ({ result }) => { check(result, 3); });",
].join('\n');

function sdkTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-sdk-2',
    name: 'second-case',
    description: 'loader-derived description',
    labels: ['category:Synthetic', 'difficulty:Easy'],
    category: 'Synthetic',
    difficulty: 'Easy',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'Prompt two',
    context: [],
    expectedOutcomes: ['second passes'],
    sourceFile: 'evals/suite.eval.js',
    sourceFileName: 'suite.eval.js',
    sourceLanguage: 'javascript',
    sourceHash: 'abc',
    sourceCode: WHOLE_FILE,
    definition: {
      registeredAs: 'sdk',
      options: {
        prompt: 'Prompt two',
        description: 'Second case in the suite',
        expectedOutcomes: ['second passes', 'second is fast'],
        labels: ['category:Synthetic', 'difficulty:Easy', 'team:platform'],
        timeout: 45000,
      },
      bodySource: 'async ({ result }) => { check(result, 2); }',
    },
    ...overrides,
  } as TestCase;
}

describe('SdkTestDefinitionView — captured definition', () => {
  it('renders the filename header, segments, and Pretty by default with ONLY this test\'s options', () => {
    render(h(SdkTestDefinitionView, { testCase: sdkTestCase() }));
    const view = screen.getByTestId('sdk-test-definition-view');
    expect(view.getAttribute('data-mode')).toBe('captured');
    expect(screen.getByText('evals/suite.eval.js')).toBeTruthy();
    expect(screen.getByText('JavaScript')).toBeTruthy();

    // Segments present, Pretty selected.
    expect(screen.getByTestId('sdk-definition-segment-pretty').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('sdk-definition-segment-evaluate').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('sdk-definition-segment-file').getAttribute('aria-selected')).toBe('false');

    const pretty = screen.getByTestId('sdk-definition-pretty');
    expect(within(pretty).getByText('Prompt two')).toBeTruthy();
    expect(within(pretty).getByText('Second case in the suite')).toBeTruthy();
    expect(within(pretty).getByText('second passes')).toBeTruthy();
    expect(within(pretty).getByText('second is fast')).toBeTruthy();
    expect(within(pretty).getByText('team:platform')).toBeTruthy();
    expect(screen.getByTestId('sdk-definition-timeout').textContent).toContain('45000');

    // The OTHER tests in the file are not shown.
    expect(screen.queryByText(/first-case/)).toBeNull();
    expect(screen.queryByText(/third-case/)).toBeNull();
    expect(screen.queryByText(/Prompt one/)).toBeNull();
    // No "Source File" pointer row duplicating the header.
    expect(screen.queryByTestId('test-case-source-pointer')).toBeNull();
    // Whole-file / evaluate bodies are not mounted while on Pretty.
    expect(screen.queryByTestId('sdk-definition-evaluate')).toBeNull();
    expect(screen.queryByTestId('eval-source-code-view')).toBeNull();
  });

  it('Evaluate function segment shows the highlighted callback text, not the rest of the file', () => {
    render(h(SdkTestDefinitionView, { testCase: sdkTestCase() }));
    fireEvent.click(screen.getByTestId('sdk-definition-segment-evaluate'));
    const body = screen.getByTestId('sdk-definition-evaluate-body');
    expect(body.textContent).toContain('check(result, 2)');
    expect(body.textContent).not.toContain('check(result, 1)');
    expect(body.textContent).not.toContain('third-case');
    // Prism emitted tokens (e.g. `async` keyword).
    expect(body.querySelectorAll('.token').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('sdk-definition-pretty')).toBeNull();
  });

  it('flags a truncated evaluate body', () => {
    render(h(SdkTestDefinitionView, {
      testCase: sdkTestCase({
        definition: { registeredAs: 'sdk', options: {}, bodySource: '() => {} /* … */', bodyTruncated: true },
      }),
    }));
    fireEvent.click(screen.getByTestId('sdk-definition-segment-evaluate'));
    expect(screen.getByText(/truncated at import/i)).toBeTruthy();
  });

  it('Whole file segment renders the pre-existing EvalSourceCodeView, expanded, with every test', () => {
    render(h(SdkTestDefinitionView, { testCase: sdkTestCase() }));
    fireEvent.click(screen.getByTestId('sdk-definition-segment-file'));
    expect(screen.getByTestId('eval-source-code-view')).toBeTruthy();
    const body = screen.getByTestId('eval-source-code-body');
    expect(body.textContent).toContain('first-case');
    expect(body.textContent).toContain('second-case');
    expect(body.textContent).toContain('third-case');
  });

  it('Pretty view with no prompt in options shows the deterministic-test placeholder', () => {
    render(h(SdkTestDefinitionView, {
      testCase: sdkTestCase({
        definition: { registeredAs: 'sdk', options: {}, bodySource: '() => {}' },
      }),
    }));
    expect(screen.getByText(/No agent prompt \(deterministic test\)/)).toBeTruthy();
    expect(screen.queryByTestId('sdk-definition-timeout')).toBeNull();
  });
});

describe('SdkTestDefinitionView — legacy record (no definition)', () => {
  it('falls back to the whole-file view with a re-import hint and no segments', () => {
    render(h(SdkTestDefinitionView, { testCase: sdkTestCase({ definition: undefined }) }));
    const view = screen.getByTestId('sdk-test-definition-view');
    expect(view.getAttribute('data-mode')).toBe('legacy');
    expect(screen.getByTestId('sdk-definition-legacy-hint').textContent).toMatch(/re-import/i);
    expect(screen.getByTestId('eval-source-code-view')).toBeTruthy();
    expect(screen.queryByTestId('sdk-definition-segments')).toBeNull();
  });
});

describe('SdkTestDefinitionView — non-SDK', () => {
  it('renders nothing for a JSON test case or null', () => {
    const { container } = render(h(SdkTestDefinitionView, {
      testCase: sdkTestCase({ sourceFile: undefined, definition: undefined }),
    }));
    expect(container.innerHTML).toBe('');
    const { container: c2 } = render(h(SdkTestDefinitionView, { testCase: null }));
    expect(c2.innerHTML).toBe('');
  });
});
