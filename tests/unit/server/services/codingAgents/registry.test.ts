/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractUsername } from '@/server/services/codingAgents/registry';

describe('extractUsername', () => {
  const originalEnv = process.env;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AH_USERNAME;
    delete process.env.AGENT_HEALTH_USERNAME;
    process.env.AH_QUIET_DEPRECATIONS = '1';
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should extract username from macOS path', () => {
    expect(extractUsername('/Users/jadhanir/Documents/GitHub/agent-health')).toBe('jadhanir');
  });

  it('should extract username from Linux path', () => {
    expect(extractUsername('/home/ubuntu/projects/my-app')).toBe('ubuntu');
  });

  it('should return unknown for unrecognized paths', () => {
    expect(extractUsername('/var/data/something')).toBe('unknown');
  });

  it('should return unknown for empty path', () => {
    expect(extractUsername('')).toBe('unknown');
  });

  it('should handle nested macOS paths', () => {
    expect(extractUsername('/Users/alice/Desktop/work/repo')).toBe('alice');
  });

  it('should use AH_USERNAME env var when set', () => {
    process.env.AH_USERNAME = 'override-user';
    expect(extractUsername('/Users/jadhanir/Documents/anything')).toBe('override-user');
  });

  it('should prefer env var over path extraction', () => {
    process.env.AH_USERNAME = 'team-bot';
    expect(extractUsername('/home/deploy/app')).toBe('team-bot');
  });

  it('still accepts legacy AGENT_HEALTH_USERNAME', () => {
    process.env.AGENT_HEALTH_USERNAME = 'legacy-user';
    expect(extractUsername('/Users/anyone/path')).toBe('legacy-user');
  });

  it('prefers AH_USERNAME over legacy AGENT_HEALTH_USERNAME', () => {
    process.env.AH_USERNAME = 'new-user';
    process.env.AGENT_HEALTH_USERNAME = 'legacy-user';
    expect(extractUsername('/Users/anyone/path')).toBe('new-user');
  });
});
