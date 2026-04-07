/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { extractUsername } from '@/server/services/codingAgents/registry';

describe('extractUsername', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENT_HEALTH_USERNAME;
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

  it('should use AGENT_HEALTH_USERNAME env var when set', () => {
    process.env.AGENT_HEALTH_USERNAME = 'override-user';
    expect(extractUsername('/Users/jadhanir/Documents/anything')).toBe('override-user');
  });

  it('should prefer env var over path extraction', () => {
    process.env.AGENT_HEALTH_USERNAME = 'team-bot';
    expect(extractUsername('/home/deploy/app')).toBe('team-bot');
  });
});
