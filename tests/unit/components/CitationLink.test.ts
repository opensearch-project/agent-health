/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CitationLink } from '@/components/CitationLink';

afterEach(cleanup);

const citation = (props: React.ComponentProps<typeof CitationLink>, text: string) =>
  React.createElement(CitationLink, props, text);

describe('CitationLink', () => {
  it('opens enabled step citations and leaves disabled citations as plain text', () => {
    const onStepClick = jest.fn();
    const { rerender } = render(citation({ href: 'step:3', onStepClick }, 'Step 3'));
    fireEvent.click(screen.getByRole('button', { name: 'Step 3' }));
    expect(onStepClick).toHaveBeenCalledWith(3);

    rerender(citation({ href: 'step:3', onStepClick, canOpenStep: () => false }, 'Step 3'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Step 3').tagName).toBe('SPAN');
  });

  it('renders span metadata, prefix, custom title, and dispatches the exact ids', () => {
    const onSpanClick = jest.fn();
    render(citation({
      href: 'span:run-7:span-9',
      onSpanClick,
      canOpenSpan: (runId, spanId) => runId === 'run-7' && spanId === 'span-9',
      spanPrefix: (runId) => React.createElement('span', null, `${runId}: `),
      spanTitle: (runId, spanId) => `Open ${runId}/${spanId}`,
    }, 'evidence'));

    const button = screen.getByRole('button', { name: /run-7: evidence/ });
    expect(button.getAttribute('data-run-id')).toBe('run-7');
    expect(button.getAttribute('data-span-id')).toBe('span-9');
    expect(button.getAttribute('title')).toBe('Open run-7/span-9');
    fireEvent.click(button);
    expect(onSpanClick).toHaveBeenCalledWith('run-7', 'span-9');
  });

  it('uses a safe external anchor for ordinary hrefs and a span without an href', () => {
    const { rerender } = render(citation({ href: 'https://example.com/evidence' }, 'source'));
    const link = screen.getByRole('link', { name: 'source' });
    expect(link.getAttribute('href')).toBe('https://example.com/evidence');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');

    rerender(citation({}, 'plain'));
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('plain').tagName).toBe('SPAN');
  });
});
