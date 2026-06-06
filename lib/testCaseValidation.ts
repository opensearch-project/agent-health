/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import type { AgentContextItem } from '@/types';
import type { CreateTestCaseInput } from '@/services/storage';

// ============ Zod Schemas ============

const contextItemSchema = z
  .object({
    description: z.string(),
    value: z.string(),
  })
  .required();

const difficultySchema = z.enum(['Easy', 'Medium', 'Hard']);

/**
 * Zod schema for validating test case JSON input.
 * This validates a subset of CreateTestCaseInput fields that are relevant for the JSON editor.
 * The output is compatible with CreateTestCaseInput.
 */
export const testCaseSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional().default(''),
  category: z.string().min(1, 'Category is required'),
  subcategory: z.string().optional(),
  difficulty: difficultySchema,
  initialPrompt: z.string().min(1, 'Initial prompt is required'),
  context: z.array(contextItemSchema).optional().default([]),
  // expectedOutcomes is optional. SDK code-only tests (`test()` blocks
  // that drive pass/fail via deterministic body or inline `judge()`
  // calls) have no expectedOutcomes — so requiring "at least one
  // non-empty" here would force UI-created cross-surface-equivalent test
  // cases to invent placeholder outcomes that the runner ignores. The
  // server-side judge contract does still require expectedOutcomes when
  // it actually grades a run (see services/evaluation/evaluatorError.ts
  // — issue #242 surfaces "Missing required field" as an evaluator
  // error), but the test case schema itself shouldn't gate authoring.
  //
  // `expectedTrajectory` is intentionally NOT modelled here. It exists on
  // the persisted `TestCase` shape (set by the SDK loader from `test()`
  // options) but the JSON-paste / form authoring path doesn't surface it,
  // and adding it here without plumbing it through `ValidatedTestCaseInput`
  // / `TestCaseFormState` / the editor save path would silently drop it on
  // round-trip (PR #258 review feedback).
  expectedOutcomes: z.array(z.string()).optional().default([]),
});

export const testCasesArraySchema = z.array(testCaseSchema).min(1, 'Array cannot be empty');

// ============ Types ============

/**
 * The validated test case input from JSON.
 * This is a subset of CreateTestCaseInput with only the fields the JSON editor handles.
 * It's structurally compatible with CreateTestCaseInput for use with asyncTestCaseStorage.
 */
export type ValidatedTestCaseInput = Pick<
  CreateTestCaseInput,
  'name' | 'description' | 'category' | 'subcategory' | 'difficulty' | 'initialPrompt' | 'context' | 'expectedOutcomes'
>;

// Form state for the TestCaseEditor component
export interface TestCaseFormState {
  name: string;
  description: string;
  category: string;
  subcategory: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  initialPrompt: string;
  context: AgentContextItem[];
  expectedOutcomes: string[];
}

// ============ Validation Types ============

export interface ValidationError {
  path: string;
  message: string;
  type: 'error' | 'warning';
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  errors: ValidationError[];
  data?: T;
}

// ============ Helper Functions ============

function zodErrorToValidationErrors(error: z.ZodError): ValidationError[] {
  return error.errors.map((e) => ({
    path: e.path.join('.'),
    message: e.message,
    type: 'error' as const,
  }));
}

// ============ Validation Functions ============

/**
 * Validates a single test case JSON object.
 * Returns data compatible with CreateTestCaseInput.
 */
export function validateTestCaseJson(json: unknown): ValidationResult<ValidatedTestCaseInput> {
  // Handle array case - should use bulk import
  if (Array.isArray(json)) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Received an array. Use Bulk Import mode for multiple test cases', type: 'error' }],
    };
  }

  const result = testCaseSchema.safeParse(json);

  if (!result.success) {
    return {
      valid: false,
      errors: zodErrorToValidationErrors(result.error),
    };
  }

  // Cast is safe here - Zod has validated all required fields
  return { valid: true, errors: [], data: result.data as ValidatedTestCaseInput };
}

/**
 * Validates an array of test cases for bulk import.
 * Also handles single objects by wrapping them in an array.
 * Returns data compatible with CreateTestCaseInput[].
 */
export function validateTestCasesArrayJson(json: unknown): ValidationResult<ValidatedTestCaseInput[]> {
  // Handle single object - auto-wrap in array
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const singleResult = validateTestCaseJson(json);
    if (singleResult.valid && singleResult.data) {
      return {
        valid: true,
        errors: [],
        data: [singleResult.data],
      };
    }
    return { valid: false, errors: singleResult.errors };
  }

  const result = testCasesArraySchema.safeParse(json);

  if (!result.success) {
    return {
      valid: false,
      errors: zodErrorToValidationErrors(result.error),
    };
  }

  // Cast is safe here - Zod has validated all required fields
  return { valid: true, errors: [], data: result.data as ValidatedTestCaseInput[] };
}

/**
 * Serializes form state to JSON string for the editor.
 */
export function serializeFormToJson(formState: TestCaseFormState): string {
  const json: Record<string, unknown> = {
    name: formState.name,
    category: formState.category,
    difficulty: formState.difficulty,
    initialPrompt: formState.initialPrompt,
    expectedOutcomes: formState.expectedOutcomes.filter((o) => o.trim()),
  };

  // Only include optional fields if they have values
  if (formState.description.trim()) {
    json.description = formState.description;
  }

  if (formState.subcategory.trim()) {
    json.subcategory = formState.subcategory;
  }

  if (formState.context.length > 0) {
    json.context = formState.context;
  }

  return JSON.stringify(json, null, 2);
}

/**
 * Parses JSON string and returns form state if valid.
 */
export function parseJsonToFormState(jsonString: string): ValidationResult<TestCaseFormState> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(jsonString);
  } catch (e) {
    return {
      valid: false,
      errors: [{ path: '', message: `Invalid JSON: ${(e as Error).message}`, type: 'error' }],
    };
  }

  const validation = validateTestCaseJson(parsed);

  if (!validation.valid || !validation.data) {
    return { valid: false, errors: validation.errors };
  }

  const data = validation.data;

  return {
    valid: true,
    errors: [],
    data: {
      name: data.name,
      description: data.description || '',
      category: data.category,
      subcategory: data.subcategory || '',
      difficulty: data.difficulty,
      initialPrompt: data.initialPrompt,
      context: (data.context || []) as AgentContextItem[],
      expectedOutcomes: data.expectedOutcomes.length > 0 ? data.expectedOutcomes : [''],
    },
  };
}
