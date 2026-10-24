/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolve } from 'path';
import { withCliCoverage, CLI_COVERAGE_DIR_VAR } from '../../helpers/cliCoverage';

describe('tests/helpers/cliCoverage withCliCoverage()', () => {
  const saved = process.env[CLI_COVERAGE_DIR_VAR];
  afterEach(() => {
    if (saved === undefined) delete process.env[CLI_COVERAGE_DIR_VAR];
    else process.env[CLI_COVERAGE_DIR_VAR] = saved;
  });

  it('returns the env untouched (same object) when the opt-in variable is unset', () => {
    delete process.env[CLI_COVERAGE_DIR_VAR];
    const env = { PATH: '/bin', AH_PORT: '5440' };
    expect(withCliCoverage(env)).toBe(env);
    expect('NODE_V8_COVERAGE' in withCliCoverage(env)).toBe(false);
  });

  it('adds an ABSOLUTE NODE_V8_COVERAGE to a copy when the variable is set (children often run from temp cwds)', () => {
    process.env[CLI_COVERAGE_DIR_VAR] = 'coverage-cli/v8';
    const env = { PATH: '/bin' };
    const out = withCliCoverage(env);
    expect(out).not.toBe(env);
    expect(out.NODE_V8_COVERAGE).toBe(resolve('coverage-cli/v8'));
    expect(out.PATH).toBe('/bin');
    expect((env as Record<string, string>).NODE_V8_COVERAGE).toBeUndefined();
  });

  it('overrides an inherited NODE_V8_COVERAGE so dumps always land in the configured dir', () => {
    process.env[CLI_COVERAGE_DIR_VAR] = '/abs/dir';
    expect(withCliCoverage({ NODE_V8_COVERAGE: '/elsewhere' }).NODE_V8_COVERAGE).toBe('/abs/dir');
  });
});
