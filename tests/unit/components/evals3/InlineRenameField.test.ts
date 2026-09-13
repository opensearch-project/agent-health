/**
 * @jest-environment jsdom
 */

/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for InlineRenameField's display-mode layout.
 *
 * Regression coverage for a reported bug: a long run name overflowed its
 * header cell and ran into adjacent metadata instead of truncating. Root
 * cause was the display wrapper being `inline-flex` (shrink-to-fit -- its
 * min-content for nowrap text IS the full text width, so `min-w-0` on it is
 * a no-op and the child `truncate` span never gets a bounded width to clip
 * against). The fix makes the wrapper a block-level `flex` box (fills its
 * already width-bounded parent, like any other block box) and adds the
 * missing `min-w-0` on the truncate span itself (a flex item's default
 * minimum size is its content size, which alone blocks shrinking).
 *
 * jsdom does not compute real layout, so this test asserts the CLASS
 * CONTRACT the fix depends on (not `inline-flex`, has `flex` + `min-w-0` on
 * both the wrapper and the text span) plus the functional contract (a very
 * long value still renders fully in the DOM with `truncate` + a `title`
 * tooltip carrying the untruncated value, and edit mode still works for a
 * long name). Real-browser truncation/overlap is covered by the Playwright
 * e2e spec (tests/e2e/inline-rename-truncation.spec.ts).
 */

import * as React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { InlineRenameField } from '@/components/evals3/InlineRenameField';

describe('InlineRenameField — display-mode layout (overflow/truncation fix)', () => {
  const LONG_NAME =
    'A'.repeat(60) + '-truncation-regression-fixture-' + 'B'.repeat(60) + '-2026-01-01';

  it('renders the display wrapper as block-level `flex` (not `inline-flex`), with `min-w-0`', () => {
    render(
      React.createElement(InlineRenameField, {
        value: 'short-name',
        onSave: async () => {},
        testId: 'rename',
      })
    );
    const text = screen.getByTestId('rename-text');
    const wrapper = text.parentElement as HTMLElement;

    expect(wrapper.className).toMatch(/\bflex\b/);
    expect(wrapper.className).not.toMatch(/\binline-flex\b/);
    expect(wrapper.className).toMatch(/\bmin-w-0\b/);
  });

  it('gives the text span both `truncate` and `min-w-0` (both halves of the fix)', () => {
    render(
      React.createElement(InlineRenameField, {
        value: 'short-name',
        onSave: async () => {},
        testId: 'rename',
      })
    );
    const text = screen.getByTestId('rename-text');
    expect(text.className).toMatch(/\btruncate\b/);
    expect(text.className).toMatch(/\bmin-w-0\b/);
  });

  it('keeps the pencil button `shrink-0` so it never gets squeezed by a long name', () => {
    render(
      React.createElement(InlineRenameField, {
        value: LONG_NAME,
        onSave: async () => {},
        testId: 'rename',
      })
    );
    const btn = screen.getByTestId('rename-edit-btn');
    expect(btn.className).toMatch(/\bshrink-0\b/);
  });

  it('a very long (200-char-class) value still renders fully in the DOM behind `truncate`, with the full value in `title`', () => {
    const longValue = 'X'.repeat(200);
    render(
      React.createElement(InlineRenameField, {
        value: longValue,
        onSave: async () => {},
        testId: 'rename',
      })
    );
    const text = screen.getByTestId('rename-text');
    expect(text.textContent).toBe(longValue);
    expect(text.getAttribute('title')).toBe(longValue);
    expect(text.className).toMatch(/\btruncate\b/);
  });

  it('a custom className (e.g. a table-cell max-w cap) is appended, not dropped, alongside the fixed base classes', () => {
    render(
      React.createElement(InlineRenameField, {
        value: 'short-name',
        onSave: async () => {},
        testId: 'rename',
        className: 'max-w-[220px]',
      })
    );
    const wrapper = screen.getByTestId('rename-text').parentElement as HTMLElement;
    expect(wrapper.className).toContain('max-w-[220px]');
    // The component itself must not also assert a conflicting max-w-* --
    // two max-w utilities on one element race on Tailwind's generated
    // stylesheet order, not the className prop's intent.
    expect(wrapper.className).not.toMatch(/\bmax-w-full\b/);
  });

  it('entering edit mode with a long name renders a full-width, shrinkable input (`w-full min-w-0`)', () => {
    render(
      React.createElement(InlineRenameField, {
        value: LONG_NAME,
        onSave: async () => {},
        testId: 'rename',
      })
    );
    fireEvent.click(screen.getByTestId('rename-edit-btn'));
    const input = screen.getByTestId('rename-input') as HTMLInputElement;
    expect(input.value).toBe(LONG_NAME);
    expect(input.className).toMatch(/\bw-full\b/);
    expect(input.className).toMatch(/\bmin-w-0\b/);
  });

  it('renaming to a new long value still commits via onSave on Enter', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    render(
      React.createElement(InlineRenameField, {
        value: 'short-name',
        onSave,
        testId: 'rename',
      })
    );
    fireEvent.click(screen.getByTestId('rename-edit-btn'));
    const input = screen.getByTestId('rename-input') as HTMLInputElement;
    const newLongName = 'renamed-' + 'C'.repeat(150);
    fireEvent.change(input, { target: { value: newLongName } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await Promise.resolve();
    await Promise.resolve();

    expect(onSave).toHaveBeenCalledWith(newLongName);
  });
});
