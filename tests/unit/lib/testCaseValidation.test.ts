/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  validateTestCaseJson,
  validateTestCasesArrayJson,
  serializeFormToJson,
  parseJsonToFormState,
  testCaseSchema,
  testCasesArraySchema,
  type TestCaseFormState,
} from '@/lib/testCaseValidation';

describe('testCaseValidation', () => {
  describe('testCaseSchema', () => {
    it('should validate a valid test case', () => {
      const validTestCase = {
        name: 'Test Case 1',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Find the root cause',
        expectedOutcomes: ['Identify the issue'],
      };

      const result = testCaseSchema.safeParse(validTestCase);
      expect(result.success).toBe(true);
    });

    it('should require name', () => {
      const invalidTestCase = {
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Find the root cause',
        expectedOutcomes: ['Identify the issue'],
      };

      const result = testCaseSchema.safeParse(invalidTestCase);
      expect(result.success).toBe(false);
    });

    it('should require non-empty name', () => {
      const invalidTestCase = {
        name: '',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Find the root cause',
        expectedOutcomes: ['Identify the issue'],
      };

      const result = testCaseSchema.safeParse(invalidTestCase);
      expect(result.success).toBe(false);
    });

    it('should validate difficulty enum', () => {
      const validDifficulties = ['Easy', 'Medium', 'Hard'];
      validDifficulties.forEach((difficulty) => {
        const testCase = {
          name: 'Test',
          category: 'RCA',
          difficulty,
          initialPrompt: 'Test',
          expectedOutcomes: ['Test'],
        };
        const result = testCaseSchema.safeParse(testCase);
        expect(result.success).toBe(true);
      });

      const invalidTestCase = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Invalid',
        initialPrompt: 'Test',
        expectedOutcomes: ['Test'],
      };
      const result = testCaseSchema.safeParse(invalidTestCase);
      expect(result.success).toBe(false);
    });

    it('should require at least one non-empty expected outcome', () => {
      const testCaseWithEmptyOutcomes = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        expectedOutcomes: ['', '   '],
      };

      const result = testCaseSchema.safeParse(testCaseWithEmptyOutcomes);
      expect(result.success).toBe(false);
    });

    it('should accept optional fields', () => {
      const testCaseWithOptionals = {
        name: 'Test',
        description: 'A description',
        category: 'RCA',
        subcategory: 'Log Analysis',
        difficulty: 'Hard',
        initialPrompt: 'Test prompt',
        context: [{ description: 'Context item', value: 'Value' }],
        expectedOutcomes: ['Expected outcome'],
      };

      const result = testCaseSchema.safeParse(testCaseWithOptionals);
      expect(result.success).toBe(true);
    });

    it('should validate context items structure', () => {
      const invalidContext = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        context: [{ description: 'Missing value' }],
        expectedOutcomes: ['Test'],
      };

      const result = testCaseSchema.safeParse(invalidContext);
      expect(result.success).toBe(false);
    });
  });

  describe('testCasesArraySchema', () => {
    it('should validate array of test cases', () => {
      const testCases = [
        {
          name: 'Test 1',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Prompt 1',
          expectedOutcomes: ['Outcome 1'],
        },
        {
          name: 'Test 2',
          category: 'Alerts',
          difficulty: 'Medium',
          initialPrompt: 'Prompt 2',
          expectedOutcomes: ['Outcome 2'],
        },
      ];

      const result = testCasesArraySchema.safeParse(testCases);
      expect(result.success).toBe(true);
    });

    it('should require at least one test case', () => {
      const result = testCasesArraySchema.safeParse([]);
      expect(result.success).toBe(false);
    });
  });

  describe('validateTestCaseJson', () => {
    it('should return valid result for valid test case', () => {
      const validTestCase = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test prompt',
        expectedOutcomes: ['Expected outcome'],
      };

      const result = validateTestCaseJson(validTestCase);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.data).toBeDefined();
      expect(result.data?.name).toBe('Test');
    });

    it('should return error for array input', () => {
      const arrayInput = [{ name: 'Test' }];

      const result = validateTestCaseJson(arrayInput);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Bulk Import');
    });

    it('should return errors for invalid test case', () => {
      const invalidTestCase = {
        name: '',
        category: '',
        difficulty: 'Invalid',
      };

      const result = validateTestCaseJson(invalidTestCase);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateTestCasesArrayJson', () => {
    it('should validate array of test cases', () => {
      const testCases = [
        {
          name: 'Test',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        },
      ];

      const result = validateTestCasesArrayJson(testCases);
      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should auto-wrap single object in array', () => {
      const singleTestCase = {
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        expectedOutcomes: ['Outcome'],
      };

      const result = validateTestCasesArrayJson(singleTestCase);
      expect(result.valid).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should return errors for invalid single object', () => {
      const invalidTestCase = {
        name: '',
      };

      const result = validateTestCasesArrayJson(invalidTestCase);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should return errors for invalid array items', () => {
      const testCases = [
        {
          name: 'Valid',
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        },
        {
          name: '', // Invalid: empty name
          category: 'RCA',
          difficulty: 'Easy',
          initialPrompt: 'Test',
          expectedOutcomes: ['Outcome'],
        },
      ];

      const result = validateTestCasesArrayJson(testCases);
      expect(result.valid).toBe(false);
    });
  });

  describe('serializeFormToJson', () => {
    it('should serialize form state to JSON', () => {
      const formState: TestCaseFormState = {
        name: 'Test Case',
        description: '',
        category: 'RCA',
        subcategory: '',
        difficulty: 'Medium',
        initialPrompt: 'Find the issue',
        context: [],
        expectedOutcomes: ['Outcome 1', 'Outcome 2'],
      };

      const json = serializeFormToJson(formState);
      const parsed = JSON.parse(json);

      expect(parsed.name).toBe('Test Case');
      expect(parsed.category).toBe('RCA');
      expect(parsed.difficulty).toBe('Medium');
      expect(parsed.expectedOutcomes).toEqual(['Outcome 1', 'Outcome 2']);
    });

    it('should include optional fields only when they have values', () => {
      const formState: TestCaseFormState = {
        name: 'Test',
        description: 'A description',
        category: 'RCA',
        subcategory: 'Log Analysis',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        context: [{ description: 'Key', value: 'Value' }],
        expectedOutcomes: ['Outcome'],
      };

      const json = serializeFormToJson(formState);
      const parsed = JSON.parse(json);

      expect(parsed.description).toBe('A description');
      expect(parsed.subcategory).toBe('Log Analysis');
      expect(parsed.context).toEqual([{ description: 'Key', value: 'Value' }]);
    });

    it('should exclude empty optional fields', () => {
      const formState: TestCaseFormState = {
        name: 'Test',
        description: '   ', // Whitespace only
        category: 'RCA',
        subcategory: '',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        context: [],
        expectedOutcomes: ['Outcome'],
      };

      const json = serializeFormToJson(formState);
      const parsed = JSON.parse(json);

      expect(parsed.description).toBeUndefined();
      expect(parsed.subcategory).toBeUndefined();
      expect(parsed.context).toBeUndefined();
    });

    it('should filter empty expected outcomes', () => {
      const formState: TestCaseFormState = {
        name: 'Test',
        description: '',
        category: 'RCA',
        subcategory: '',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        context: [],
        expectedOutcomes: ['Outcome 1', '', '   ', 'Outcome 2'],
      };

      const json = serializeFormToJson(formState);
      const parsed = JSON.parse(json);

      expect(parsed.expectedOutcomes).toEqual(['Outcome 1', 'Outcome 2']);
    });
  });

  describe('parseJsonToFormState', () => {
    it('should parse valid JSON to form state', () => {
      const json = JSON.stringify({
        name: 'Test',
        category: 'RCA',
        difficulty: 'Medium',
        initialPrompt: 'Test prompt',
        expectedOutcomes: ['Outcome 1'],
      });

      const result = parseJsonToFormState(json);

      expect(result.valid).toBe(true);
      expect(result.data?.name).toBe('Test');
      expect(result.data?.category).toBe('RCA');
      expect(result.data?.difficulty).toBe('Medium');
    });

    it('should return error for invalid JSON syntax', () => {
      const invalidJson = '{ invalid json }';

      const result = parseJsonToFormState(invalidJson);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain('Invalid JSON');
    });

    it('should return error for invalid test case data', () => {
      const json = JSON.stringify({
        name: '',
        category: 'RCA',
      });

      const result = parseJsonToFormState(json);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should provide default values for optional fields', () => {
      const json = JSON.stringify({
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        expectedOutcomes: ['Outcome'],
      });

      const result = parseJsonToFormState(json);

      expect(result.valid).toBe(true);
      expect(result.data?.description).toBe('');
      expect(result.data?.subcategory).toBe('');
      expect(result.data?.context).toEqual([]);
    });

    it('should ensure at least one empty expected outcome for form state', () => {
      const json = JSON.stringify({
        name: 'Test',
        category: 'RCA',
        difficulty: 'Easy',
        initialPrompt: 'Test',
        expectedOutcomes: [],
      });

      // This should fail validation because empty expectedOutcomes is not valid
      const result = parseJsonToFormState(json);
      expect(result.valid).toBe(false);
    });
  });
});
