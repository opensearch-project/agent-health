/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HighlightedCodeBlock renders via dangerouslySetInnerHTML. Its contract is
 * "raw source text in → Prism-highlighted HTML out"; Prism escapes the input
 * before wrapping tokens. Pin that so a markup-looking evaluate body (or a
 * hostile one) can never become live DOM.
 */

import * as React from 'react';
import { render } from '@testing-library/react';
import { HighlightedCodeBlock, highlightCode } from '@/components/evals3/HighlightedCodeBlock';

const h = React.createElement;

describe('HighlightedCodeBlock — escaping', () => {
  const hostile = "const s = '<img src=x onerror=alert(1)>'; // <script>alert(2)</script>";

  it('never materializes tags from the source text as DOM elements', () => {
    const { container } = render(h(HighlightedCodeBlock, { code: hostile, language: 'javascript', testId: 'blk' }));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    // The literal text is still visible to the reader.
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.textContent).toContain('<script>');
    // And Prism did highlight (tokens present).
    expect(container.querySelectorAll('.token').length).toBeGreaterThan(0);
  });

  it('highlightCode escapes `<` and `&` (the tag/entity openers) — only <span> tags are emitted', () => {
    const html = highlightCode('a < b && c > d', 'typescript');
    // Prism leaves a bare `>` alone (harmless outside a tag); `<` and `&`
    // are what would open a tag/entity and must be escaped.
    expect(html).not.toMatch(/<(?!\/?span)/);
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;&amp;');
  });

  it('renders one gutter line number per source line', () => {
    const { getByTestId } = render(h(HighlightedCodeBlock, { code: 'a\nb\nc', language: 'javascript', gutterTestId: 'g' }));
    expect(getByTestId('g').textContent?.split('\n')).toEqual(['1', '2', '3']);
  });
});
