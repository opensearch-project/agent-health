/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  humanizeFolderName,
  inferCategory,
  inferDifficulty,
  buildStableName,
  buildContextItems,
  convertTestCase,
  resolvePrompt,
  extractPathParts,
  parseTestCaseYaml,
  discoverLocalTestCases,
  convertAllFromLocal,
  fetchTestCasePathsFromGitHub,
  fetchFileFromGitHub,
  convertAllFromGitHub,
} from '@/cli/converters/holmesgpt';
import { testCaseSchema } from '@/lib/testCaseValidation';
import type { HolmesGPTTestCase } from '@/cli/converters/types';

// Mock fs for discoverLocalTestCases and convertAllFromLocal
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
    statSync: jest.fn(),
    existsSync: jest.fn(),
  };
});

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';

const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockStatSync = statSync as jest.MockedFunction<typeof statSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;

describe('holmesgpt converter', () => {
  describe('humanizeFolderName', () => {
    it('strips numeric prefix and title-cases', () => {
      expect(humanizeFolderName('01_how_many_pods')).toBe('How Many Pods');
    });

    it('handles no numeric prefix', () => {
      expect(humanizeFolderName('check_pod_status')).toBe('Check Pod Status');
    });

    it('handles single word', () => {
      expect(humanizeFolderName('03_restart')).toBe('Restart');
    });

    it('handles multi-digit prefix', () => {
      expect(humanizeFolderName('123_long_test_name')).toBe('Long Test Name');
    });
  });

  describe('inferCategory', () => {
    it('returns Kubernetes for k8s tags', () => {
      expect(inferCategory(['kubernetes', 'pods'])).toBe('Kubernetes');
      expect(inferCategory(['k8s'])).toBe('Kubernetes');
    });

    it('returns Log Analysis for logs tag', () => {
      expect(inferCategory(['logs'])).toBe('Log Analysis');
    });

    it('returns Metrics for prometheus/grafana', () => {
      expect(inferCategory(['prometheus'])).toBe('Metrics');
      expect(inferCategory(['grafana'])).toBe('Metrics');
      expect(inferCategory(['metrics'])).toBe('Metrics');
    });

    it('returns Search for elasticsearch/opensearch', () => {
      expect(inferCategory(['elasticsearch'])).toBe('Search');
      expect(inferCategory(['opensearch'])).toBe('Search');
    });

    it('returns Database for DB tags', () => {
      expect(inferCategory(['postgres'])).toBe('Database');
      expect(inferCategory(['mysql'])).toBe('Database');
      expect(inferCategory(['mongodb'])).toBe('Database');
      expect(inferCategory(['redis'])).toBe('Database');
    });

    it('returns Bash for bash tag', () => {
      expect(inferCategory(['bash'])).toBe('Bash');
    });

    it('returns Confluence for confluence tag', () => {
      expect(inferCategory(['confluence'])).toBe('Confluence');
    });

    it('returns Jira for jira tag', () => {
      expect(inferCategory(['jira'])).toBe('Jira');
    });

    it('returns General for unknown tags', () => {
      expect(inferCategory(['custom', 'unknown'])).toBe('General');
    });

    it('returns General for empty tags', () => {
      expect(inferCategory([])).toBe('General');
      expect(inferCategory()).toBe('General');
    });

    it('is case-insensitive', () => {
      expect(inferCategory(['KUBERNETES'])).toBe('Kubernetes');
      expect(inferCategory(['Logs'])).toBe('Log Analysis');
    });
  });

  describe('inferDifficulty', () => {
    it('returns Easy when tagged', () => {
      expect(inferDifficulty(['kubernetes', 'easy'])).toBe('Easy');
    });

    it('returns Hard when tagged', () => {
      expect(inferDifficulty(['hard'])).toBe('Hard');
      expect(inferDifficulty(['complex'])).toBe('Hard');
    });

    it('returns Medium by default', () => {
      expect(inferDifficulty(['kubernetes'])).toBe('Medium');
      expect(inferDifficulty([])).toBe('Medium');
      expect(inferDifficulty()).toBe('Medium');
    });

    it('is case-insensitive', () => {
      expect(inferDifficulty(['EASY'])).toBe('Easy');
      expect(inferDifficulty(['Hard'])).toBe('Hard');
    });
  });

  describe('buildStableName', () => {
    it('builds expected format', () => {
      expect(buildStableName('test_ask_holmes', '01_how_many_pods')).toBe(
        'holmesgpt/test_ask_holmes/01_how_many_pods'
      );
    });
  });

  describe('extractPathParts', () => {
    it('extracts parentDir and folderName from nested path', () => {
      const result = extractPathParts('test_ask_holmes/01_how_many_pods/test_case.yaml');
      expect(result).toEqual({ parentDir: 'test_ask_holmes', folderName: '01_how_many_pods' });
    });

    it('extracts from deeper path', () => {
      const result = extractPathParts('tests/llm/fixtures/test_holmes_checks/02_check/test_case.yaml');
      expect(result).toEqual({ parentDir: 'test_holmes_checks', folderName: '02_check' });
    });
  });

  describe('buildContextItems', () => {
    it('returns empty array for minimal test case', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
      };
      expect(buildContextItems(tc)).toEqual([]);
    });

    it('includes before_test script', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        before_test: 'kubectl apply -f setup.yaml',
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Setup Script (before_test)');
      expect(items[0].value).toBe('kubectl apply -f setup.yaml');
    });

    it('includes after_test script', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        after_test: 'kubectl delete -f setup.yaml',
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Teardown Script (after_test)');
    });

    it('includes toolsets as JSON', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        toolsets: { kubernetes: { enabled: true } },
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Toolsets');
      expect(JSON.parse(items[0].value)).toEqual({ kubernetes: { enabled: true } });
    });

    it('includes conversation_history', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        conversation_history: [{ role: 'user', content: 'previous question' }],
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Conversation History');
    });

    it('includes runbooks', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        runbooks: [{ description: 'Restart guide', link: 'https://example.com' }],
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Runbooks');
    });

    it('includes cluster_name', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        cluster_name: 'prod-cluster',
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(1);
      expect(items[0].description).toBe('Cluster Name');
      expect(items[0].value).toBe('prod-cluster');
    });

    it('includes all fields in order', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        before_test: 'setup',
        after_test: 'teardown',
        toolsets: { k8s: {} },
        conversation_history: [{ role: 'user', content: 'hi' }],
        runbooks: [{ description: 'doc', link: 'url' }],
        cluster_name: 'test-cluster',
        port_forwards: [{ namespace: 'default', service: 'svc', local_port: 8080, remote_port: 80 }],
        test_env_vars: { FOO: 'bar' },
        mocked_date: '2024-01-01',
      };
      const items = buildContextItems(tc);
      expect(items).toHaveLength(9);
      expect(items.map((i) => i.description)).toEqual([
        'Setup Script (before_test)',
        'Teardown Script (after_test)',
        'Toolsets',
        'Conversation History',
        'Runbooks',
        'Cluster Name',
        'Port Forwards',
        'Environment Variables',
        'Mocked Date',
      ]);
    });
  });

  describe('parseTestCaseYaml', () => {
    it('parses valid YAML', () => {
      const yaml = `
user_prompt: "How many pods are running?"
expected_output:
  - "3 pods are running"
tags:
  - kubernetes
  - easy
`;
      const result = parseTestCaseYaml(yaml);
      expect(result.user_prompt).toBe('How many pods are running?');
      expect(result.expected_output).toEqual(['3 pods are running']);
      expect(result.tags).toEqual(['kubernetes', 'easy']);
    });

    it('parses YAML with optional fields', () => {
      const yaml = `
user_prompt: "Check status"
expected_output:
  - "Status OK"
skip: true
skip_reason: "Requires external service"
before_test: "kubectl apply -f test.yaml"
after_test: "kubectl delete -f test.yaml"
`;
      const result = parseTestCaseYaml(yaml);
      expect(result.skip).toBe(true);
      expect(result.skip_reason).toBe('Requires external service');
      expect(result.before_test).toBe('kubectl apply -f test.yaml');
      expect(result.after_test).toBe('kubectl delete -f test.yaml');
    });
  });

  describe('resolvePrompt', () => {
    it('returns string prompt directly', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'How many pods?',
        expected_output: ['3'],
      };
      expect(resolvePrompt(tc)).toBe('How many pods?');
    });

    it('joins array prompt with newlines', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: ['Check the service.', 'Look for latency issues.'],
        expected_output: ['result'],
      };
      expect(resolvePrompt(tc)).toBe('Check the service.\nLook for latency issues.');
    });

    it('synthesizes prompt from checks when no user_prompt', () => {
      const tc: HolmesGPTTestCase = {
        expected_output: ['All checks passed'],
        checks: [
          { name: 'PodCheck', description: 'Check pods', query: 'Are pods running?' },
          { name: 'SvcCheck', description: 'Check services', query: 'Are services up?' },
        ],
      };
      expect(resolvePrompt(tc)).toBe('Run health checks: Are pods running?; Are services up?');
    });

    it('uses check description when query is missing', () => {
      const tc: HolmesGPTTestCase = {
        expected_output: ['result'],
        checks: [{ name: 'Test', description: 'Check something', query: '' }],
      };
      expect(resolvePrompt(tc)).toBe('Run health checks: Check something');
    });

    it('falls back to description for compaction-style tests', () => {
      const tc: HolmesGPTTestCase = {
        expected_output: ['compacted'],
        description: 'Verify compaction of a multi-turn conversation',
      };
      expect(resolvePrompt(tc)).toBe('Verify compaction of a multi-turn conversation');
    });

    it('returns empty string when nothing available', () => {
      const tc: HolmesGPTTestCase = {
        expected_output: ['result'],
      };
      expect(resolvePrompt(tc)).toBe('');
    });
  });

  describe('convertTestCase', () => {
    it('converts a basic test case', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'How many pods are running in the default namespace?',
        expected_output: ['3 pods are running', 'All pods healthy'],
        tags: ['kubernetes', 'easy'],
      };

      const result = convertTestCase(tc, '01_how_many_pods', 'test_ask_holmes');

      expect(result.name).toBe('holmesgpt/test_ask_holmes/01_how_many_pods');
      expect(result.description).toBe('How Many Pods');
      expect(result.category).toBe('Kubernetes');
      expect(result.difficulty).toBe('Easy');
      expect(result.initialPrompt).toBe('How many pods are running in the default namespace?');
      expect(result.expectedOutcomes).toEqual(['3 pods are running', 'All pods healthy']);
    });

    it('adds check expectations for test_holmes_checks', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'Run health checks',
        expected_output: ['All checks passed'],
        tags: ['kubernetes'],
        checks: [{ name: 'PodRunning', description: 'Check pods', query: 'pods running?' }],
        expected_results: { PodRunning: 'pass' },
      };

      const result = convertTestCase(tc, '01_health_check', 'test_holmes_checks');
      expect(result.expectedOutcomes).toContain("Check 'PodRunning' should result in: pass");
      expect(result.expectedOutcomes).toHaveLength(2);
    });

    it('uses tc.description when present', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        description: 'Verify compaction of conversation',
      };

      const result = convertTestCase(tc, '01_compaction', 'compaction');
      expect(result.description).toBe('Verify compaction of conversation');
    });

    it('handles array user_prompt', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: ['Investigate latency.', 'Check traces.'],
        expected_output: ['found issue'],
        tags: ['kubernetes'],
      };

      const result = convertTestCase(tc, '114_checkout_latency', 'test_ask_holmes');
      expect(result.initialPrompt).toBe('Investigate latency.\nCheck traces.');
    });

    it('handles test case with no user_prompt (checks format)', () => {
      const tc: HolmesGPTTestCase = {
        expected_output: ['Check passed'],
        tags: ['kubernetes'],
        checks: [{ name: 'PodCheck', description: 'Check pods', query: 'Are pods running?' }],
        expected_results: { PodCheck: 'pass' },
      };

      const result = convertTestCase(tc, '01_basic_pod_health', 'test_holmes_checks');
      expect(result.initialPrompt).toBe('Run health checks: Are pods running?');
      expect(result.expectedOutcomes).toContain("Check 'PodCheck' should result in: pass");
    });

    it('filters difficulty tags from subcategory', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'test',
        expected_output: ['result'],
        tags: ['kubernetes', 'easy', 'pods'],
      };

      const result = convertTestCase(tc, '01_test', 'test_ask_holmes');
      expect(result.subcategory).toBe('kubernetes, pods');
    });

    it('validates against testCaseSchema', () => {
      const tc: HolmesGPTTestCase = {
        user_prompt: 'How many pods?',
        expected_output: ['3 pods'],
        tags: ['kubernetes'],
      };

      const result = convertTestCase(tc, '01_pods', 'test_ask_holmes');
      const validation = testCaseSchema.safeParse(result);
      expect(validation.success).toBe(true);
    });
  });

  describe('discoverLocalTestCases', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('discovers test_case.yaml files in test directories', () => {
      mockExistsSync.mockImplementation((path: any) => {
        return path === '/fixtures/test_ask_holmes' || path === '/fixtures/test_holmes_checks';
      });

      // test_ask_holmes directory structure
      mockReaddirSync.mockImplementation((dir: any) => {
        if (dir === '/fixtures/test_ask_holmes') return ['01_pods', '02_logs'] as any;
        if (dir === '/fixtures/test_ask_holmes/01_pods') return ['test_case.yaml'] as any;
        if (dir === '/fixtures/test_ask_holmes/02_logs') return ['test_case.yaml'] as any;
        if (dir === '/fixtures/test_holmes_checks') return ['01_check'] as any;
        if (dir === '/fixtures/test_holmes_checks/01_check') return ['test_case.yaml'] as any;
        return [] as any;
      });

      mockStatSync.mockImplementation((path: any) => {
        const p = path as string;
        const isDir =
          p.endsWith('01_pods') ||
          p.endsWith('02_logs') ||
          p.endsWith('01_check');
        return { isDirectory: () => isDir } as any;
      });

      const results = discoverLocalTestCases('/fixtures');
      expect(results).toHaveLength(3);
      expect(results).toContain('/fixtures/test_ask_holmes/01_pods/test_case.yaml');
      expect(results).toContain('/fixtures/test_ask_holmes/02_logs/test_case.yaml');
      expect(results).toContain('/fixtures/test_holmes_checks/01_check/test_case.yaml');
    });
  });

  describe('convertAllFromLocal', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('converts test cases and reports skipped/errors', () => {
      mockExistsSync.mockImplementation((path: any) => {
        return path === '/fixtures/test_ask_holmes';
      });

      mockReaddirSync.mockImplementation((dir: any) => {
        if (dir === '/fixtures/test_ask_holmes') return ['01_pods', '02_skipped'] as any;
        if (dir === '/fixtures/test_ask_holmes/01_pods') return ['test_case.yaml'] as any;
        if (dir === '/fixtures/test_ask_holmes/02_skipped') return ['test_case.yaml'] as any;
        return [] as any;
      });

      mockStatSync.mockImplementation((path: any) => {
        const p = path as string;
        const isDir = p.endsWith('01_pods') || p.endsWith('02_skipped');
        return { isDirectory: () => isDir } as any;
      });

      mockReadFileSync.mockImplementation((path: any) => {
        const p = path as string;
        if (p.includes('01_pods')) {
          return `
user_prompt: "How many pods?"
expected_output:
  - "3 pods"
tags:
  - kubernetes
`;
        }
        if (p.includes('02_skipped')) {
          return `
user_prompt: "Skipped test"
expected_output:
  - "result"
skip: true
skip_reason: "Not supported"
`;
        }
        return '';
      });

      const result = convertAllFromLocal('/fixtures');
      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0].name).toBe('holmesgpt/test_ask_holmes/01_pods');
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe('Not supported');
      expect(result.errors).toHaveLength(0);
    });

    it('reports errors for invalid YAML', () => {
      mockExistsSync.mockImplementation((path: any) => {
        return path === '/fixtures/test_ask_holmes';
      });

      mockReaddirSync.mockImplementation((dir: any) => {
        if (dir === '/fixtures/test_ask_holmes') return ['01_bad'] as any;
        if (dir === '/fixtures/test_ask_holmes/01_bad') return ['test_case.yaml'] as any;
        return [] as any;
      });

      mockStatSync.mockImplementation(() => {
        return { isDirectory: () => false } as any;
      });

      // Make the first call (for directory) return isDirectory true, rest false
      mockStatSync.mockImplementation((path: any) => {
        const p = path as string;
        return { isDirectory: () => p.endsWith('01_bad') } as any;
      });

      mockReadFileSync.mockImplementation(() => {
        return `
user_prompt: ""
expected_output: []
`;
      });

      const result = convertAllFromLocal('/fixtures');
      expect(result.testCases).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });

    it('falls back to walking basePath itself when no known subdirectories exist', () => {
      mockExistsSync.mockReturnValue(false);

      mockReaddirSync.mockImplementation((dir: any) => {
        if (dir === '/fixtures') return ['weird_dir'] as any;
        if (dir === '/fixtures/weird_dir') return ['test_case.yaml'] as any;
        return [] as any;
      });

      mockStatSync.mockImplementation((path: any) => {
        const p = path as string;
        return { isDirectory: () => p.endsWith('weird_dir') } as any;
      });

      mockReadFileSync.mockReturnValue(`
user_prompt: "Ping"
expected_output:
  - "pong"
`);

      const result = convertAllFromLocal('/fixtures');
      expect(result.testCases).toHaveLength(1);
      // extractPathParts derives parentDir from the path *relative to basePath*,
      // so a file directly under basePath has '.' as its parentDir.
      expect(result.testCases[0].name).toBe('holmesgpt/./weird_dir');
    });
  });

  describe('fetchTestCasePathsFromGitHub', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('filters the repo tree for test_case.yaml files under the fixtures path', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          tree: [
            { path: 'tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml', type: 'blob' },
            { path: 'tests/llm/fixtures/test_ask_holmes/01_pods/README.md', type: 'blob' },
            { path: 'tests/llm/fixtures/test_ask_holmes/01_pods', type: 'tree' },
            { path: 'other/unrelated/test_case.yaml', type: 'blob' },
          ],
        }),
      });
      global.fetch = mockFetch as any;

      const paths = await fetchTestCasePathsFromGitHub('robusta-dev/holmesgpt', 'master');
      expect(paths).toEqual(['tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml']);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/robusta-dev/holmesgpt/git/trees/master?recursive=1',
        expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'agent-health-cli' }) })
      );
    });

    it('URL-encodes a branch name containing a slash', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ tree: [] }) });
      global.fetch = mockFetch as any;

      await fetchTestCasePathsFromGitHub('robusta-dev/holmesgpt', 'feature/import-fixtures');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/robusta-dev/holmesgpt/git/trees/feature%2Fimport-fixtures?recursive=1',
        expect.anything()
      );
    });

    it('throws when the GitHub API responds with a non-ok status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }) as any;

      await expect(fetchTestCasePathsFromGitHub('robusta-dev/holmesgpt', 'master')).rejects.toThrow(
        'GitHub API error: 404 Not Found'
      );
    });
  });

  describe('fetchFileFromGitHub', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('fetches raw file content', async () => {
      const mockFetch = jest.fn().mockResolvedValue({ ok: true, text: async () => 'user_prompt: hi' });
      global.fetch = mockFetch as any;

      const content = await fetchFileFromGitHub(
        'tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml',
        'robusta-dev/holmesgpt',
        'master'
      );
      expect(content).toBe('user_prompt: hi');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/robusta-dev/holmesgpt/master/tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml',
        expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'agent-health-cli' }) })
      );
    });

    it('throws when the raw file fetch responds with a non-ok status', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;

      await expect(fetchFileFromGitHub('some/path/test_case.yaml')).rejects.toThrow(
        'Failed to fetch some/path/test_case.yaml: 500'
      );
    });
  });

  describe('convertAllFromGitHub', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('fetches, converts, skips, and reports errors across the repo', async () => {
      const treeResponse = {
        ok: true,
        json: async () => ({
          tree: [
            { path: 'tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml', type: 'blob' },
            { path: 'tests/llm/fixtures/test_ask_holmes/02_skipped/test_case.yaml', type: 'blob' },
            { path: 'tests/llm/fixtures/test_ask_holmes/03_bad/test_case.yaml', type: 'blob' },
          ],
        }),
      };

      const fileContents: Record<string, string> = {
        'tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml': `
user_prompt: "How many pods?"
expected_output:
  - "3 pods"
tags:
  - kubernetes
`,
        'tests/llm/fixtures/test_ask_holmes/02_skipped/test_case.yaml': `
user_prompt: "Skipped"
expected_output:
  - "result"
skip: true
skip_reason: "Flaky upstream"
`,
        'tests/llm/fixtures/test_ask_holmes/03_bad/test_case.yaml': 'not: [valid, yaml, :::',
      };

      const onProgress = jest.fn();
      const mockFetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('api.github.com')) {
          return Promise.resolve(treeResponse);
        }
        const match = Object.keys(fileContents).find((path) => url.includes(path));
        return Promise.resolve({ ok: true, text: async () => fileContents[match!] });
      });
      global.fetch = mockFetch as any;

      const result = await convertAllFromGitHub('robusta-dev/holmesgpt', 'master', onProgress);

      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0].name).toBe('holmesgpt/test_ask_holmes/01_pods');
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toBe('Flaky upstream');
      expect(result.errors).toHaveLength(1);
      expect(onProgress).toHaveBeenCalledWith(1, 3);
      expect(onProgress).toHaveBeenCalledWith(3, 3);
    });

    it('propagates a fetch failure for an individual file as a per-path error', async () => {
      const treeResponse = {
        ok: true,
        json: async () => ({
          tree: [{ path: 'tests/llm/fixtures/test_ask_holmes/01_pods/test_case.yaml', type: 'blob' }],
        }),
      };

      global.fetch = jest.fn().mockImplementation((url: string) => {
        if (url.includes('api.github.com')) return Promise.resolve(treeResponse);
        return Promise.resolve({ ok: false, status: 503 });
      }) as any;

      const result = await convertAllFromGitHub('robusta-dev/holmesgpt', 'master');
      expect(result.testCases).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('503');
    });

    it('propagates a top-level failure (e.g. tree fetch error) by rejecting', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' }) as any;

      await expect(convertAllFromGitHub('robusta-dev/holmesgpt', 'master')).rejects.toThrow('GitHub API error');
    });
  });
});
