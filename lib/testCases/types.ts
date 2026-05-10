/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK types for code-based test case authoring.
 *
 * These types provide a friendlier API surface for defining test cases in TypeScript,
 * mapping to the internal `ValidatedTestCaseInput` type used by the pipeline.
 */

/**
 * Input for a single test case definition.
 * Uses developer-friendly field names that map to internal schema fields.
 */
export interface TestCaseInput {
  /** The prompt sent to the agent under test */
  prompt: string;
  /** Category for grouping (e.g., 'RCA', 'Kubernetes', 'Database') */
  category: string;
  /** Difficulty level */
  difficulty: 'Easy' | 'Medium' | 'Hard';
  /** Optional description of what this test case evaluates */
  description?: string;
  /** Optional subcategory for finer grouping */
  subcategory?: string;
  /** Optional context items passed to the agent (e.g., logs, metrics, architecture docs) */
  context?: Array<{ description: string; value: string }>;
  /** Expected outcomes the LLM judge evaluates against */
  expect: string[];
}

/**
 * Shared defaults applied to all test cases in a suite.
 * Any field specified here is used when a case doesn't provide its own value.
 */
export interface TestCaseDefaults {
  category?: string;
  difficulty?: 'Easy' | 'Medium' | 'Hard';
  subcategory?: string;
  context?: Array<{ description: string; value: string }>;
}

/**
 * Input for `defineTestSuite()` — groups test cases with shared defaults.
 */
export interface TestSuiteInput {
  /** Optional suite name (for documentation purposes) */
  name?: string;
  /** Default values applied to all cases unless overridden */
  defaults?: TestCaseDefaults;
  /** Array of test case definitions (name is required, others inherit from defaults) */
  cases: Array<{ name: string } & Partial<TestCaseInput> & Pick<TestCaseInput, 'prompt' | 'expect'>>;
}
