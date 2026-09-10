/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  linkifyStepCitations,
  parseCitationHref,
  sanitizeCitationUrl,
} from '@/lib/citations';

describe('judge evidence citations', () => {
  it('links case-insensitive in-range Step references', () => {
    expect(linkifyStepCitations('Step 2 edited the file; step 1 inspected it.', 2)).toBe(
      '[Step 2](step:2) edited the file; [step 1](step:1) inspected it.',
    );
  });

  it('leaves out-of-range Step references and plain text untouched', () => {
    expect(linkifyStepCitations('Step 3 edited the file.', 2)).toBe('Step 3 edited the file.');
    expect(linkifyStepCitations('No trajectory evidence was cited.', 2)).toBe('No trajectory evidence was cited.');
  });

  it('does not rewrite citations inside existing links or code', () => {
    const markdown = '[existing Step 1](https://example.com) and `Step 2`';
    expect(linkifyStepCitations(markdown, 2)).toBe(markdown);
  });

  it('parses the comparison span-id citation convention', () => {
    expect(parseCitationHref('span:run-123:0af31b')).toEqual({
      type: 'span',
      runId: 'run-123',
      spanId: '0af31b',
    });
    expect(parseCitationHref('step:23')).toEqual({ type: 'step', stepNumber: 23 });
    expect(parseCitationHref('https://example.com')).toBeNull();
  });

  it('allows citation and safe web URLs but drops script schemes', () => {
    expect(sanitizeCitationUrl('span:run-1:span-2')).toBe('span:run-1:span-2');
    expect(sanitizeCitationUrl('step:2')).toBe('step:2');
    expect(sanitizeCitationUrl('https://example.com')).toBe('https://example.com');
    expect(sanitizeCitationUrl('javascript:alert(1)')).toBe('');
  });
});
