/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HolmesGPT YAML → Agent Health JSON converter.
 * Fetches test cases from GitHub and converts them to Agent Health format.
 */

import { parse as parseYaml } from 'yaml';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative, basename, dirname } from 'path';
import { testCaseSchema, type ValidatedTestCaseInput } from '@/lib/testCaseValidation.js';
import type { HolmesGPTTestCase, ConversionResult } from './types.js';
import type { AgentContextItem } from '@/types/index.js';

const DEFAULT_REPO = 'robusta-dev/holmesgpt';
const DEFAULT_BRANCH = 'master';
const FIXTURES_PATH = 'tests/llm/fixtures';

/**
 * Fetch the full file tree from a GitHub repo and filter for test_case.yaml files.
 */
export async function fetchTestCasePathsFromGitHub(
  repo: string = DEFAULT_REPO,
  branch: string = DEFAULT_BRANCH
): Promise<string[]> {
  const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'agent-health-cli' },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { tree: Array<{ path: string; type: string }> };
  return data.tree
    .filter(
      (item) =>
        item.type === 'blob' &&
        item.path.startsWith(`${FIXTURES_PATH}/`) &&
        item.path.endsWith('/test_case.yaml')
    )
    .map((item) => item.path);
}

/**
 * Fetch a single file's content from GitHub raw.
 */
export async function fetchFileFromGitHub(
  filePath: string,
  repo: string = DEFAULT_REPO,
  branch: string = DEFAULT_BRANCH
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(branch)}/${filePath}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'agent-health-cli' },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${filePath}: ${response.status}`);
  }

  return response.text();
}

/**
 * Discover test_case.yaml files in a local directory.
 */
export function discoverLocalTestCases(basePath: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry === 'test_case.yaml') {
        results.push(fullPath);
      }
    }
  }

  // Walk test_ask_holmes and test_holmes_checks directories
  const testDirs = ['test_ask_holmes', 'test_holmes_checks', 'compaction'];
  for (const testDir of testDirs) {
    const fullDir = join(basePath, testDir);
    if (existsSync(fullDir)) {
      walk(fullDir);
    }
  }

  // If no subdirectories found, walk the basePath itself
  if (results.length === 0) {
    walk(basePath);
  }

  return results;
}

/**
 * Parse a test_case.yaml file content.
 */
export function parseTestCaseYaml(content: string): HolmesGPTTestCase {
  return parseYaml(content) as HolmesGPTTestCase;
}

/**
 * Infer category from tags.
 */
export function inferCategory(tags: string[] = []): string {
  const lower = tags.map((t) => t.toLowerCase());

  if (lower.some((t) => t === 'kubernetes' || t === 'k8s')) return 'Kubernetes';
  if (lower.some((t) => t === 'logs' || t === 'logging')) return 'Log Analysis';
  if (lower.some((t) => t === 'prometheus' || t === 'grafana' || t === 'metrics')) return 'Metrics';
  if (lower.some((t) => t === 'elasticsearch' || t === 'opensearch')) return 'Search';
  if (lower.some((t) => t === 'postgres' || t === 'mysql' || t === 'mongodb' || t === 'redis' || t === 'database'))
    return 'Database';
  if (lower.some((t) => t === 'bash' || t === 'shell')) return 'Bash';
  if (lower.some((t) => t === 'confluence' || t === 'wiki')) return 'Confluence';
  if (lower.some((t) => t === 'jira')) return 'Jira';

  return 'General';
}

/**
 * Infer difficulty from tags.
 */
export function inferDifficulty(tags: string[] = []): 'Easy' | 'Medium' | 'Hard' {
  const lower = tags.map((t) => t.toLowerCase());

  if (lower.includes('easy')) return 'Easy';
  if (lower.includes('hard') || lower.includes('complex')) return 'Hard';
  return 'Medium';
}

/**
 * Convert folder name to human-readable name.
 * "01_how_many_pods" → "How Many Pods"
 */
export function humanizeFolderName(folderName: string): string {
  // Strip numeric prefix (e.g., "01_")
  const stripped = folderName.replace(/^\d+_/, '');
  // Replace underscores with spaces and title case
  return stripped
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Build a stable name for idempotent matching on re-import.
 * "holmesgpt/test_ask_holmes/01_how_many_pods"
 */
export function buildStableName(parentDir: string, folderName: string): string {
  return `holmesgpt/${parentDir}/${folderName}`;
}

/**
 * Build context items from test case metadata.
 */
export function buildContextItems(tc: HolmesGPTTestCase): AgentContextItem[] {
  const context: AgentContextItem[] = [];

  if (tc.before_test) {
    context.push({ description: 'Setup Script (before_test)', value: tc.before_test });
  }

  if (tc.after_test) {
    context.push({ description: 'Teardown Script (after_test)', value: tc.after_test });
  }

  if (tc.toolsets && Object.keys(tc.toolsets).length > 0) {
    context.push({ description: 'Toolsets', value: JSON.stringify(tc.toolsets, null, 2) });
  }

  if (tc.conversation_history && tc.conversation_history.length > 0) {
    context.push({
      description: 'Conversation History',
      value: JSON.stringify(tc.conversation_history, null, 2),
    });
  }

  if (tc.runbooks && tc.runbooks.length > 0) {
    context.push({ description: 'Runbooks', value: JSON.stringify(tc.runbooks, null, 2) });
  }

  if (tc.cluster_name) {
    context.push({ description: 'Cluster Name', value: tc.cluster_name });
  }

  if (tc.port_forwards && tc.port_forwards.length > 0) {
    context.push({ description: 'Port Forwards', value: JSON.stringify(tc.port_forwards, null, 2) });
  }

  if (tc.test_env_vars && Object.keys(tc.test_env_vars).length > 0) {
    context.push({ description: 'Environment Variables', value: JSON.stringify(tc.test_env_vars, null, 2) });
  }

  if (tc.mocked_date) {
    context.push({ description: 'Mocked Date', value: tc.mocked_date });
  }

  return context;
}

/**
 * Resolve user_prompt from a test case.
 * Handles: string, string[], or missing (falls back to checks/description).
 */
export function resolvePrompt(tc: HolmesGPTTestCase): string {
  // Direct string prompt
  if (typeof tc.user_prompt === 'string') {
    return tc.user_prompt;
  }

  // Array of prompt parts — join into a single string
  if (Array.isArray(tc.user_prompt)) {
    return tc.user_prompt.join('\n');
  }

  // No user_prompt — synthesize from checks (test_holmes_checks format)
  if (tc.checks && tc.checks.length > 0) {
    const checkDescriptions = tc.checks.map((c) => c.query || c.description).join('; ');
    return `Run health checks: ${checkDescriptions}`;
  }

  // Fall back to description (compaction format)
  if (tc.description) {
    return tc.description;
  }

  return '';
}

/**
 * Convert a single HolmesGPT test case to Agent Health format.
 */
export function convertTestCase(
  tc: HolmesGPTTestCase,
  folderName: string,
  parentDir: string
): ValidatedTestCaseInput {
  const expectedOutcomes = Array.isArray(tc.expected_output)
    ? [...tc.expected_output]
    : [tc.expected_output];

  // For test_holmes_checks, add check expectations
  if (tc.checks && tc.expected_results) {
    for (const [checkName, expectedResult] of Object.entries(tc.expected_results)) {
      expectedOutcomes.push(`Check '${checkName}' should result in: ${expectedResult}`);
    }
  }

  return {
    name: buildStableName(parentDir, folderName),
    description: tc.description || humanizeFolderName(folderName),
    category: inferCategory(tc.tags),
    subcategory: tc.tags?.filter((t) => !['easy', 'medium', 'hard'].includes(t.toLowerCase())).join(', '),
    difficulty: inferDifficulty(tc.tags),
    initialPrompt: resolvePrompt(tc),
    context: buildContextItems(tc),
    expectedOutcomes,
  };
}

/**
 * Extract parentDir and folderName from a file path.
 * Input: "tests/llm/fixtures/test_ask_holmes/01_how_many_pods/test_case.yaml"
 * Output: { parentDir: "test_ask_holmes", folderName: "01_how_many_pods" }
 */
export function extractPathParts(filePath: string): { parentDir: string; folderName: string } {
  // The folder containing test_case.yaml
  const folder = dirname(filePath);
  const folderName = basename(folder);
  const parentDir = basename(dirname(folder));
  return { parentDir, folderName };
}

/**
 * Convert all test cases from a local directory.
 */
export function convertAllFromLocal(basePath: string): ConversionResult {
  const testCases: ValidatedTestCaseInput[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const errors: Array<{ path: string; error: string }> = [];

  const files = discoverLocalTestCases(basePath);

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const tc = parseTestCaseYaml(content);

      if (tc.skip) {
        skipped.push({ path: file, reason: tc.skip_reason || 'Marked as skip' });
        continue;
      }

      const relPath = relative(basePath, file);
      const { parentDir, folderName } = extractPathParts(relPath);
      const converted = convertTestCase(tc, folderName, parentDir);

      // Validate against schema
      const result = testCaseSchema.safeParse(converted);
      if (result.success) {
        testCases.push(converted);
      } else {
        errors.push({
          path: file,
          error: result.error.errors.map((e) => e.message).join('; '),
        });
      }
    } catch (err: any) {
      errors.push({ path: file, error: err.message });
    }
  }

  return { testCases, skipped, errors };
}

/**
 * Convert all test cases by fetching from GitHub.
 */
export async function convertAllFromGitHub(
  repo: string = DEFAULT_REPO,
  branch: string = DEFAULT_BRANCH,
  onProgress?: (current: number, total: number) => void
): Promise<ConversionResult> {
  const testCases: ValidatedTestCaseInput[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const errors: Array<{ path: string; error: string }> = [];

  const paths = await fetchTestCasePathsFromGitHub(repo, branch);

  for (let i = 0; i < paths.length; i++) {
    const filePath = paths[i];
    onProgress?.(i + 1, paths.length);

    try {
      const content = await fetchFileFromGitHub(filePath, repo, branch);
      const tc = parseTestCaseYaml(content);

      if (tc.skip) {
        skipped.push({ path: filePath, reason: tc.skip_reason || 'Marked as skip' });
        continue;
      }

      // Extract path relative to fixtures dir
      const relPath = filePath.replace(`${FIXTURES_PATH}/`, '');
      const { parentDir, folderName } = extractPathParts(relPath);
      const converted = convertTestCase(tc, folderName, parentDir);

      // Validate against schema
      const result = testCaseSchema.safeParse(converted);
      if (result.success) {
        testCases.push(converted);
      } else {
        errors.push({
          path: filePath,
          error: result.error.errors.map((e) => e.message).join('; '),
        });
      }
    } catch (err: any) {
      errors.push({ path: filePath, error: err.message });
    }
  }

  return { testCases, skipped, errors };
}
