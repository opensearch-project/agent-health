/** @jest-environment jsdom */
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => React.createElement('div', null,
    children.startsWith('**Authored**') ? React.createElement('strong', null, 'Authored') : children),
}));
import { TestCaseDetailPanel } from '@/components/TestCaseDetailPanel';

describe('TestCaseDetailPanel context dispositions', () => {
  it('groups context, reports delivery math, and renders documentation markdown', () => {
    render(React.createElement(TestCaseDetailPanel, { testCase: {
      id: 'tc', name: 'tc', category: 'test', difficulty: 'Easy', initialPrompt: 'Go', createdAt: new Date().toISOString(),
      context: [
        { description: 'legacy', value: 'plain' },
        { description: 'directive', value: '/tmp/fixture', disposition: 'connector' },
        { description: 'manifest', value: '**Authored** documentation', disposition: 'documentation' },
      ],
    } as any }));
    expect(screen.getByTestId('context-delivery-summary').textContent).toContain('prompt + 1 context items · directives: 1 · documentation: 1');
    expect(screen.getByText('Delivered to agent')).toBeTruthy();
    expect(screen.getByText('Connector directive — not delivered')).toBeTruthy();
    expect(screen.getByText('Documentation — not delivered')).toBeTruthy();
    expect(screen.getByText('Authored').tagName).toBe('STRONG');
  });
});
