/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for CollapsibleTestCaseDefinition's two provenance branches.
 *
 * Regression guards for the redundant-rows cleanup (owner feedback):
 *  - SDK branch: renders ONLY EvalSourceCodeView (whose header carries the
 *    path/badge/copy) — the old standalone "Source File" row and sha256
 *    line must NOT come back.
 *  - JSON branch: still renders the full untruncated pretty-printed JSON
 *    with a working copy button (unchanged behavior, but the copy handler
 *    was simplified to JSON-only so lock it in).
 *
 * Written with React.createElement (not JSX) — this repo's jest config
 * only matches `*.test.ts`, and plain `.ts` files can't parse JSX syntax.
 */

import * as React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

// react-markdown (inside ui/markdown) is ESM-only and can't be parsed by this
// node/ts-jest config — mock it like tests/unit/components/TestCaseDetailPanel.test.ts does.
jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) =>
    require('react').createElement('div', null, children),
  hasRealMarkdown: () => false,
}));

import { CollapsibleTestCaseDefinition } from '@/components/evals3/CollapsibleTestCaseDefinition';
import type { TestCase } from '@/types';

const h = React.createElement;

function baseTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-1',
    name: 'Test Case',
    description: 'desc',
    labels: [],
    category: 'General',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    initialPrompt: 'What is 2+2?',
    context: [],
    expectedOutcomes: ['answer is 4'],
    ...overrides,
  } as TestCase;
}

function openSection() {
  fireEvent.click(screen.getByRole('button', { name: /test case definition/i }));
}

describe('CollapsibleTestCaseDefinition — SDK branch (no redundant rows)', () => {
  const sdkTc = () => baseTestCase({
    sourceFile: 'dist/wixqa.eval.js',
    sourceFileName: 'wixqa.eval.js',
    sourceLanguage: 'javascript',
    sourceHash: 'f1a4bec9a927935b0000000000000000',
    sourceCode: "test('a', () => {});",
  });

  it('renders EvalSourceCodeView and NOT the old standalone Source File row / sha256 line', () => {
    render(h(CollapsibleTestCaseDefinition, { testCase: sdkTc(), defaultOpen: true }));
    // The eval-source header (with the full path) is the single source row.
    expect(screen.getByTestId('eval-source-code-view')).toBeTruthy();
    expect(screen.getByText('dist/wixqa.eval.js')).toBeTruthy();
    // Removed duplicates must not come back:
    expect(screen.queryByText(/^Source File$/i)).toBeNull();
    expect(screen.queryByText(/sha256:/)).toBeNull();
    // Exactly ONE row shows the path (the eval-source header), not two.
    expect(screen.getAllByText('dist/wixqa.eval.js')).toHaveLength(1);
  });

  it('eval source starts collapsed inside the definition section and expands on toggle', () => {
    render(h(CollapsibleTestCaseDefinition, { testCase: sdkTc(), defaultOpen: true }));
    expect(screen.queryByTestId('eval-source-code-body')).toBeNull();
    fireEvent.click(screen.getByTestId('eval-source-toggle'));
    expect(screen.getByTestId('eval-source-code-body')).toBeTruthy();
  });

  // Legacy SDK record (no per-test `definition`) → whole-file fallback with
  // a re-import hint, so nothing regresses for test cases imported before
  // the capture existed.
  it('legacy SDK record (no definition) shows the whole-file fallback + re-import hint', () => {
    render(h(CollapsibleTestCaseDefinition, { testCase: sdkTc(), defaultOpen: true }));
    expect(screen.getByTestId('sdk-test-definition-view').getAttribute('data-mode')).toBe('legacy');
    expect(screen.getByTestId('sdk-definition-legacy-hint')).toBeTruthy();
    expect(screen.queryByTestId('sdk-definition-segments')).toBeNull();
  });

  // Captured SDK record → Pretty view of THIS test by default, segments to
  // switch to the evaluate function or the whole file.
  it('captured SDK record renders Pretty by default with only this test\'s options', () => {
    const tc = baseTestCase({
      name: 'only-me',
      sourceFile: 'dist/suite.eval.js',
      sourceFileName: 'suite.eval.js',
      sourceLanguage: 'javascript',
      sourceHash: 'h',
      sourceCode: "test('other-one', {prompt:'x'}, () => {});\ntest('only-me', {prompt:'Only my prompt'}, () => {});",
      definition: {
        registeredAs: 'sdk',
        options: { prompt: 'Only my prompt', expectedOutcomes: ['just mine'] },
        bodySource: '() => { mine(); }',
      },
    });
    render(h(CollapsibleTestCaseDefinition, { testCase: tc, defaultOpen: true }));
    expect(screen.getByTestId('sdk-test-definition-view').getAttribute('data-mode')).toBe('captured');
    expect(screen.getByTestId('sdk-definition-segment-pretty').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Only my prompt')).toBeTruthy();
    expect(screen.getByText('just mine')).toBeTruthy();
    expect(screen.queryByText(/other-one/)).toBeNull();
    // Header still shows the path exactly once; no old duplicate rows.
    expect(screen.getAllByText('dist/suite.eval.js')).toHaveLength(1);
    expect(screen.queryByText(/sha256:/)).toBeNull();
    fireEvent.click(screen.getByTestId('sdk-definition-segment-evaluate'));
    expect(screen.getByTestId('sdk-definition-evaluate-body').textContent).toContain('mine()');
  });
});

describe('CollapsibleTestCaseDefinition — JSON branch (unchanged)', () => {
  const originalClipboard = navigator.clipboard;
  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  it('renders the readable definition with raw JSON behind a toggle for a non-SDK test case', () => {
    const tc = baseTestCase(); // no sourceFile
    render(h(CollapsibleTestCaseDefinition, { testCase: tc, defaultOpen: true }));
    // Readable definition (from TestCaseDefinition) leads — not a JSON dump.
    expect(screen.getByText('What is 2+2?')).toBeTruthy();
    expect(screen.queryByTestId('raw-test-case-json')).toBeNull();
    // Raw JSON is still reachable, untruncated, behind the toggle.
    fireEvent.click(screen.getByText(/view raw json/i));
    expect(screen.getByTestId('raw-test-case-json')).toBeTruthy();
    expect(screen.getByText(/"initialPrompt": "What is 2\+2\?"/)).toBeTruthy();
    expect(screen.getByText(/"expectedOutcomes"/)).toBeTruthy();
    // No eval-source view for JSON test cases.
    expect(screen.queryByTestId('eval-source-code-view')).toBeNull();
  });

  it('copy button copies the pretty-printed JSON', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const tc = baseTestCase();
    render(h(CollapsibleTestCaseDefinition, { testCase: tc, defaultOpen: true }));
    fireEvent.click(screen.getByText(/view raw json/i));

    await act(async () => {
      fireEvent.click(screen.getByTitle(/copy json/i));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(tc, null, 2));
  });

  it('section itself defaults closed and opens on header click', () => {
    const tc = baseTestCase();
    render(h(CollapsibleTestCaseDefinition, { testCase: tc }));
    expect(screen.queryByText('What is 2+2?')).toBeNull();
    openSection();
    expect(screen.getByText('What is 2+2?')).toBeTruthy();
  });
});

describe('TestCaseDefinition — SDK / code-authored cases', () => {
  const { TestCaseDefinition } = require('@/components/TestCaseDefinition');
  const testCase = baseTestCase({
    initialPrompt: 'Why are checkout requests failing?',
    expectedOutcomes: ['Identify the payment-service timeout'],
  });
  const sdkCase: TestCase = {
    ...testCase,
    id: 'tc-sdk',
    name: 'sdk registered test',
    initialPrompt: '',
    expectedOutcomes: [],
    sourceFile: 'examples/eval-files/demo.eval.ts',
  } as TestCase;

  it('renders the source-file pointer instead of an empty declarative rubric', () => {
    render(React.createElement(TestCaseDefinition, { testCase: sdkCase }));
    expect(screen.getByText('examples/eval-files/demo.eval.ts')).toBeTruthy();
    expect(screen.getByText(/isn't serializable from runtime state/)).toBeTruthy();
    expect(screen.queryByText(/expected outcomes/i)).toBeNull();
  });

  it('still renders the declarative rubric for JSON cases', () => {
    render(React.createElement(TestCaseDefinition, { testCase }));
    expect(screen.getByText('Why are checkout requests failing?')).toBeTruthy();
    expect(screen.getByText('Identify the payment-service timeout')).toBeTruthy();
  });

  it('uses canonical, case-sensitive label parsing for chips', () => {
    render(React.createElement(TestCaseDefinition, { testCase: {
      ...testCase,
      category: undefined,
      difficulty: undefined,
      labels: ['category:RCA', 'difficulty:Hard', 'subcategory:network', 'Category:NotCanonical', 'difficulty:Impossible'],
    } }));
    for (const chip of ['RCA', 'Hard', 'network', 'Category:NotCanonical']) {
      expect(screen.getByText(chip)).toBeTruthy();
    }
    expect(screen.queryByText('difficulty:Impossible')).toBeNull();
  });
});
