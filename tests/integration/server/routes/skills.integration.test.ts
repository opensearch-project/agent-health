/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for /api/skills/* endpoints
 *
 * These tests verify:
 * 1. GET /api/skills/discover returns available skills
 * 2. POST /api/skills/validate validates a skill directory
 * 3. POST /api/skills/validate returns errors for invalid paths
 * 4. GET /api/skills/results returns 400 without workspace param
 *
 * Run tests:
 *   npm test -- --testPathPattern=skills.integration
 *
 * Prerequisites:
 *   - Backend server running: npm run dev:server
 */

import { getTestBackendUrl } from '@/tests/integration/testConfig';

const TEST_TIMEOUT = 30000;
const BASE_URL = getTestBackendUrl();

const checkBackend = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
};

describe('Skills API Integration Tests', () => {
  let backendAvailable = false;

  beforeAll(async () => {
    backendAvailable = await checkBackend();
    if (!backendAvailable) {
      console.warn(
        'Backend not available at',
        BASE_URL,
        '- skipping integration tests'
      );
    }
  }, TEST_TIMEOUT);

  describe('GET /api/skills/discover', () => {
    it(
      'should return an array of discovered skills',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/discover`);

        expect(response.ok).toBe(true);
        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data).toHaveProperty('skills');
        expect(Array.isArray(data.skills)).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      'should return skills with correct shape',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/discover`);
        const data = await response.json();

        if (data.skills.length > 0) {
          const skill = data.skills[0];
          expect(skill).toHaveProperty('path');
          expect(skill).toHaveProperty('name');
          expect(skill).toHaveProperty('description');
          expect(typeof skill.path).toBe('string');
          expect(typeof skill.name).toBe('string');
          expect(typeof skill.description).toBe('string');
        }
      },
      TEST_TIMEOUT
    );

    it(
      'should find skills in .claude/skills directory',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/discover`);
        const data = await response.json();

        const paths = data.skills.map((s: { path: string }) => s.path);
        expect(paths.some((p: string) => p.includes('.claude/skills/'))).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  describe('POST /api/skills/validate', () => {
    it(
      'should return 400 when path is missing',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toBeDefined();
      },
      TEST_TIMEOUT
    );

    it(
      'should validate a known skill directory successfully',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '.claude/skills/config-auth' }),
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.valid).toBe(true);
        expect(data.skill).toBeDefined();
        expect(data.skill.metadata.name).toBe('config-auth');
        expect(data.errors).toEqual([]);
      },
      TEST_TIMEOUT
    );

    it(
      'should return invalid for non-existent path',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '/nonexistent/skill/path' }),
        });

        expect(response.ok).toBe(true);
        const data = await response.json();
        expect(data.valid).toBe(false);
        expect(data.errors.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT
    );

    it(
      'should include evals info when evals.json exists',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: '.claude/skills/config-auth' }),
        });

        const data = await response.json();
        if (data.evalsFile) {
          expect(data.evalsFile).toHaveProperty('evals');
          expect(Array.isArray(data.evalsFile.evals)).toBe(true);
          expect(data.evalsFile.evals.length).toBeGreaterThan(0);
        }
      },
      TEST_TIMEOUT
    );
  });

  describe('GET /api/skills/results', () => {
    it(
      'should return 400 when workspace is missing',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(`${BASE_URL}/api/skills/results`);

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('workspace');
      },
      TEST_TIMEOUT
    );

    it(
      'should return 404 for non-existent workspace',
      async () => {
        if (!backendAvailable) return;

        const response = await fetch(
          `${BASE_URL}/api/skills/results?workspace=/nonexistent/workspace`
        );

        expect(response.status).toBe(404);
      },
      TEST_TIMEOUT
    );
  });
});
