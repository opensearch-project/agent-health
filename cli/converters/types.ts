/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TypeScript interfaces for HolmesGPT test_case.yaml format.
 * Based on https://github.com/robusta-dev/holmesgpt/tree/master/tests/llm/fixtures
 */

export interface HolmesGPTPortForward {
  namespace: string;
  service: string;
  local_port: number;
  remote_port: number;
}

export interface HolmesGPTRunbook {
  description: string;
  link: string;
}

export interface HolmesGPTConversationMessage {
  role: string;
  content: string;
}

export interface HolmesGPTCheck {
  name: string;
  description: string;
  query: string;
  tags?: string[];
}

export interface HolmesGPTTestCase {
  user_prompt?: string | string[];
  description?: string;
  expected_output: string | string[];
  tags?: string[];
  before_test?: string;
  after_test?: string;
  skip?: boolean;
  skip_reason?: string;
  mocked_date?: string;
  cluster_name?: string;
  toolsets?: Record<string, unknown>;
  port_forwards?: HolmesGPTPortForward[];
  test_env_vars?: Record<string, string>;
  conversation_history?: HolmesGPTConversationMessage[];
  include_files?: string[];
  runbooks?: HolmesGPTRunbook[];
  checks?: HolmesGPTCheck[];
  expected_results?: Record<string, string>;
}

export interface ConversionResult {
  testCases: import('@/lib/testCaseValidation').ValidatedTestCaseInput[];
  skipped: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; error: string }>;
}
