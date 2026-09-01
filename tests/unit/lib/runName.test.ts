/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateRunNameUpdate, MAX_RUN_NAME_LENGTH } from '@/lib/runName';

describe('validateRunNameUpdate', () => {
  it('accepts a normal non-empty name', () => {
    const result = validateRunNameUpdate('My Run');
    expect(result).toEqual({ ok: true, value: 'My Run' });
  });

  it('trims leading/trailing whitespace on success', () => {
    const result = validateRunNameUpdate('  My Run  ');
    expect(result).toEqual({ ok: true, value: 'My Run' });
  });

  it('rejects a non-string value', () => {
    const result = validateRunNameUpdate(123 as unknown);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/must be a string/);
    }
  });

  it('rejects undefined/null', () => {
    expect(validateRunNameUpdate(undefined).ok).toBe(false);
    expect(validateRunNameUpdate(null).ok).toBe(false);
  });

  it('rejects an empty string', () => {
    const result = validateRunNameUpdate('');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/must not be empty/);
    }
  });

  it('rejects a whitespace-only string', () => {
    const result = validateRunNameUpdate('   ');
    expect(result.ok).toBe(false);
  });

  it('accepts a name exactly at the length cap', () => {
    const name = 'x'.repeat(MAX_RUN_NAME_LENGTH);
    const result = validateRunNameUpdate(name);
    expect(result).toEqual({ ok: true, value: name });
  });

  it('rejects a name over the length cap', () => {
    const name = 'x'.repeat(MAX_RUN_NAME_LENGTH + 1);
    const result = validateRunNameUpdate(name);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/200 characters or fewer/);
    }
  });

  it('length cap is evaluated on the trimmed value, not the raw input', () => {
    // Padding is all whitespace and trims away, so the *trimmed* name is
    // within the cap even though the raw string is longer.
    const padded = ' '.repeat(50) + 'x'.repeat(MAX_RUN_NAME_LENGTH) + ' '.repeat(50);
    const result = validateRunNameUpdate(padded);
    expect(result.ok).toBe(true);
  });
});
