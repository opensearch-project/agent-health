/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// @ts-nocheck - Test file uses simplified mock objects
import { generateMockTrajectory } from '@/services/evaluation/mockTrajectory';
import { TestCase, ToolCallStatus } from '@/types';

describe('mockTrajectory', () => {
  const mockTestCase: TestCase = {
    id: 'tc-1',
    name: 'High CPU Investigation',
    initialPrompt: 'Investigate high CPU usage',
    expectedOutcomes: ['Identify CPU bottleneck'],
    category: 'RCA',
    context: [],
    version: 1,
    createdAt: '2024-01-01T00:00:00Z',
    labels: [],
  };

  describe('generateMockTrajectory', () => {
    it('should generate a complete trajectory with all step types', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);

      // Should have at least one of each key type
      const stepTypes = trajectory.map(s => s.type);
      expect(stepTypes).toContain('assistant');
      expect(stepTypes).toContain('action');
      expect(stepTypes).toContain('tool_result');
      expect(stepTypes).toContain('response');
    }, 10000);

    it('should generate steps with valid structure', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);

      trajectory.forEach(step => {
        expect(step.id).toBeDefined();
        expect(step.timestamp).toBeGreaterThan(0);
        expect(step.type).toBeDefined();
        expect(step.content).toBeDefined();
      });
    }, 10000);

    it('should include action steps with tool information', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);
      const actionSteps = trajectory.filter(s => s.type === 'action');

      expect(actionSteps.length).toBeGreaterThan(0);
      actionSteps.forEach(step => {
        expect(step.toolName).toBeDefined();
        expect(step.toolArgs).toBeDefined();
      });
    }, 10000);

    it('should include tool_result steps with status', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);
      const resultSteps = trajectory.filter(s => s.type === 'tool_result');

      expect(resultSteps.length).toBeGreaterThan(0);
      resultSteps.forEach(step => {
        expect(step.status).toBe(ToolCallStatus.SUCCESS);
      });
    }, 10000);

    it('should include test case name in initial thought', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);
      const assistantStep = trajectory.find(s => s.type === 'assistant');

      expect(assistantStep?.content).toContain(mockTestCase.name);
    }, 10000);

    it('should generate steps with increasing timestamps', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);

      for (let i = 1; i < trajectory.length; i++) {
        expect(trajectory[i].timestamp).toBeGreaterThanOrEqual(trajectory[i - 1].timestamp);
      }
    }, 10000);

    it('should end with a response step', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);
      const lastStep = trajectory[trajectory.length - 1];

      expect(lastStep.type).toBe('response');
    }, 10000);

    it('should generate unique IDs for each step', async () => {
      const trajectory = await generateMockTrajectory(mockTestCase);
      const ids = trajectory.map(s => s.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
    }, 10000);
  });
});
