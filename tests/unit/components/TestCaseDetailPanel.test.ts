/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describeFixturePayload, TestCaseDetailPanel } from '@/components/TestCaseDetailPanel';
import type { TestCase } from '@/types';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => {
    const [heading, ...body] = children.split(/\n+/).filter(Boolean);
    const bodyText = body.join(' ') || heading;
    const bold = /\*\*([^*]+)\*\*/.exec(bodyText);
    const inline = React.createElement(
      'p',
      null,
      bold ? bodyText.slice(0, bold.index) : bodyText,
      bold && React.createElement('strong', null, bold[1]),
      bold ? bodyText.slice((bold.index || 0) + bold[0].length) : null,
    );
    return React.createElement(
      React.Fragment,
      null,
      heading.startsWith('# ') ? React.createElement('h1', null, heading.slice(2)) : null,
      inline,
    );
  },
}));

function makeTestCase(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: 'tc-fixture',
    name: 'Fixture case',
    description: 'Investigate the prepared workspace',
    labels: [],
    category: 'RCA',
    difficulty: 'Medium',
    currentVersion: 1,
    versions: [],
    isPromoted: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    initialPrompt: 'Find the root cause',
    context: [],
    ...overrides,
  };
}

describe('TestCaseDetailPanel fixture rendering', () => {
  it('detects authored manifest fields without guessing at unknown payload shapes', () => {
    const manifest = describeFixturePayload({
      manifest: {
        authoredNotes: '# Prepared workspace\n\nInspect this as reviewer context.',
        tree: [{ path: 'src/cache.ts', size: 1536, sha256: 'abcdef1234567890' }],
      },
    });

    expect(manifest).toMatchObject({
      isManifest: true,
      authoredNotes: '# Prepared workspace\n\nInspect this as reviewer context.',
      tree: [{ path: 'src/cache.ts', size: 1536, sha256: 'abcdef1234567890' }],
    });
    expect(manifest.rawJson).toContain('\n    "authoredNotes"');

    const unknown = describeFixturePayload({ files: [{ path: 'src/cache.ts' }] });
    expect(unknown).toMatchObject({ isManifest: false, authoredNotes: undefined, tree: undefined });
    expect(unknown.rawJson).toBe('{\n  "files": [\n    {\n      "path": "src/cache.ts"\n    }\n  ]\n}');
  });

  it('renders a fixture as first-class non-delivered scenario context with collapsible payload', () => {
    render(React.createElement(TestCaseDetailPanel, { testCase: makeTestCase({
      fixture: {
        type: 'filesystem-workspace',
        ref: 'cache-refactor',
        integrity: 'sha256:abc123',
        payload: { files: [{ path: 'src/cache.ts' }] },
      },
    }) }));

    const fixture = screen.getByTestId('workspace-fixture');
    expect(fixture.textContent).toContain('Workspace fixture');
    expect(fixture.textContent).toContain(
      'cache-refactor — integrity-pinned (filesystem-workspace), not disclosed to the agent',
    );
    expect(screen.getByText('Fixture payload').closest('details')?.hasAttribute('open')).toBe(false);
    expect(screen.getByText('Raw JSON').closest('details')?.hasAttribute('open')).toBe(false);
    expect(fixture.textContent).toContain('src/cache.ts');
  });

  it('renders authored notes as markdown and the manifest tree as a compact table', () => {
    const sha256 = 'abcdef1234567890abcdef1234567890';
    render(React.createElement(TestCaseDetailPanel, { testCase: makeTestCase({
      fixture: {
        type: 'filesystem-workspace',
        ref: 'cache-refactor',
        integrity: 'sha256:abc123',
        payload: {
          manifest: {
            authoredNotes: '# Cache refactor fixture\n\nReview **policy boundaries** before implementation.',
            tree: [{ path: 'src/cache.ts', size: 1536, sha256 }],
          },
        },
      },
    }) }));

    expect(screen.getByText('For reviewers and audit — not delivered to the agent, not read by the judge.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cache refactor fixture' })).toBeTruthy();
    expect(screen.getByText('policy boundaries').tagName).toBe('STRONG');
    expect(screen.getByRole('table', { name: 'Fixture file tree' })).toBeTruthy();
    expect(screen.getByText('src/cache.ts')).toBeTruthy();
    expect(screen.getByText('1.5 KB')).toBeTruthy();
    expect(screen.getByTitle(sha256).textContent).toBe('abcdef123456');
    expect(screen.getByText('Raw JSON')).toBeTruthy();
  });

  it('formats fixture tree sizes across bytes, KB, MB, and GB', () => {
    const entries = [
      { path: 'bytes.txt', size: 512, sha256: 'a'.repeat(64) },
      { path: 'kilobytes.bin', size: 12 * 1024, sha256: 'b'.repeat(64) },
      { path: 'megabytes.bin', size: 1.5 * 1024 * 1024, sha256: 'c'.repeat(64) },
      { path: 'gigabytes.bin', size: 2 * 1024 * 1024 * 1024, sha256: 'd'.repeat(64) },
    ];
    render(React.createElement(TestCaseDetailPanel, { testCase: makeTestCase({
      fixture: {
        type: 'filesystem-workspace',
        ref: 'large-workspace',
        integrity: 'sha256:abc123',
        payload: { manifest: { tree: entries } },
      },
    }) }));

    expect(screen.getByText('512 B')).toBeTruthy();
    expect(screen.getByText('12 KB')).toBeTruthy();
    expect(screen.getByText('1.5 MB')).toBeTruthy();
    expect(screen.getByText('2.0 GB')).toBeTruthy();
  });

  it('falls back to raw JSON for malformed or unknown manifest shapes', () => {
    const malformed = describeFixturePayload({
      manifest: { tree: [{ path: 'missing-size.txt', sha256: 'abc' }] },
    });
    expect(malformed).toMatchObject({
      isManifest: false,
      authoredNotes: undefined,
      tree: undefined,
    });

    expect(describeFixturePayload(undefined)).toEqual({
      authoredNotes: undefined,
      tree: undefined,
      isManifest: false,
      rawJson: 'undefined',
    });
  });

  it('does not render fixture UI for backward-compatible cases without the field', () => {
    render(React.createElement(TestCaseDetailPanel, { testCase: makeTestCase() }));

    expect(screen.queryByTestId('workspace-fixture')).toBeNull();
  });
});

describe('TestCaseDetailPanel context dispositions', () => {
  it('uses the shared grouping, delivery summary, and documentation markdown', () => {
    render(React.createElement(TestCaseDetailPanel, { testCase: makeTestCase({
      context: [
        { description: 'legacy', value: 'plain' },
        { description: 'directive', value: '/tmp/fixture', disposition: 'connector' },
        { description: 'manifest', value: '**Authored** documentation', disposition: 'documentation' },
      ],
    }) }));

    expect(screen.getByTestId('context-delivery-summary').textContent)
      .toContain('prompt + 1 context items · directives: 1 · documentation: 1');
    expect(screen.getByText('Delivered to agent')).toBeTruthy();
    expect(screen.getByText('Connector directive — not delivered')).toBeTruthy();
    expect(screen.getByText('Documentation — not delivered')).toBeTruthy();
    expect(screen.getByText('Authored').tagName).toBe('STRONG');
  });
});
