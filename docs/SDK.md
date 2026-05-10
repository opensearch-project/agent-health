# Test Case SDK

Write evaluation test cases in TypeScript with full type safety, IDE autocomplete, and programmatic generation.

## Quick Start

```typescript
// evals/my-tests.eval.ts
import { defineTestCases, testCase } from '@opensearch-project/agent-health';

export default defineTestCases([
  testCase('High CPU Investigation', {
    prompt: 'Investigate high CPU on web-server-01',
    category: 'RCA',
    difficulty: 'Medium',
    expect: ['Identify root cause process', 'Suggest remediation'],
  }),
]);
```

Run:
```bash
npx agent-health benchmark -f evals/my-tests.eval.ts -a my-agent
```

## API Reference

### `testCase(name, input)`

Define a single test case with developer-friendly field names.

```typescript
testCase(name: string, input: TestCaseInput): ValidatedTestCaseInput
```

| Field | Type | Required | Maps to |
|-------|------|----------|---------|
| `prompt` | `string` | Yes | `initialPrompt` |
| `expect` | `string[]` | Yes | `expectedOutcomes` |
| `category` | `string` | Yes | `category` |
| `difficulty` | `'Easy' \| 'Medium' \| 'Hard'` | Yes | `difficulty` |
| `description` | `string` | No | `description` |
| `subcategory` | `string` | No | `subcategory` |
| `context` | `Array<{description, value}>` | No | `context` |

### `defineTestCases(cases)`

Type-safe wrapper for a flat array of test cases. Use as default export.

```typescript
defineTestCases(cases: ValidatedTestCaseInput[]): ValidatedTestCaseInput[]
```

### `defineTestSuite(config)`

Group test cases with shared defaults. Individual cases can override any default.

```typescript
defineTestSuite(config: {
  name?: string;
  defaults?: {
    category?: string;
    difficulty?: 'Easy' | 'Medium' | 'Hard';
    subcategory?: string;
    context?: Array<{description: string; value: string}>;
  };
  cases: Array<{ name: string; prompt: string; expect: string[]; ... }>;
}): ValidatedTestCaseInput[]
```

## Patterns

### Suite with shared defaults

```typescript
import { defineTestSuite } from '@opensearch-project/agent-health';

export default defineTestSuite({
  defaults: { category: 'Kubernetes', difficulty: 'Hard' },
  cases: [
    { name: 'Pod crash', prompt: 'Pod is CrashLoopBackOff', expect: ['Check OOM'] },
    { name: 'Node down', prompt: 'Node is NotReady', expect: ['Check kubelet'] },
  ],
});
```

### Programmatic generation

```typescript
import { defineTestCases, testCase } from '@opensearch-project/agent-health';
import scenarios from './scenarios.json';

export default defineTestCases(
  scenarios.map(s => testCase(s.title, {
    prompt: s.question,
    category: s.category,
    difficulty: s.level,
    expect: s.criteria,
  }))
);
```

### Shared context across files

```typescript
// evals/shared.ts
export const prodClusterContext = [
  { description: 'Cluster', value: 'production / us-east-1 / EKS 1.28' },
  { description: 'Monitoring', value: 'Prometheus + Grafana' },
];

// evals/k8s.eval.ts
import { defineTestSuite } from '@opensearch-project/agent-health';
import { prodClusterContext } from './shared';

export default defineTestSuite({
  defaults: { category: 'Kubernetes', difficulty: 'Hard', context: prodClusterContext },
  cases: [/* ... */],
});
```

## How It Works

```
.eval.ts file (source of truth, in git)
       │
       │  npx agent-health benchmark -f evals.ts
       ▼
  Load via dynamic import()
       │
       ▼
  Zod validation (same schema as JSON imports)
       │
       ▼
  Bulk upsert to server (matched by name — no duplicates)
       │
       ▼
  Test cases visible in UI (with "Code" badge, read-only)
       │
       ▼
  Benchmark executes → results stored in OpenSearch
```

## Source Types

| Source | Created by | Editable in UI? | Source of truth |
|--------|-----------|-----------------|-----------------|
| `code` | `.eval.ts` files | No (read-only, "Code" badge) | Git repo |
| `managed` | UI forms, JSON import | Yes | OpenSearch |

### Idempotent sync

Code-sourced test cases are matched by **name**. On each run:
- If a test case with that name exists → updated (new version)
- If not → created

This means re-running `benchmark -f evals.ts` never creates duplicates.

## File Extensions

The `-f` flag auto-detects format by extension:

| Extension | Format | Source type |
|-----------|--------|-------------|
| `.ts` | TypeScript module | `code` |
| `.js` | JavaScript module | `code` |
| `.mjs` | ES module | `code` |
| `.json` | JSON array | `managed` |

## Examples

Working examples are included in the package:

```bash
# Flat test cases
npx agent-health benchmark -f cli/demo/sample-rca.eval.ts -a demo

# Suite with shared defaults
npx agent-health benchmark -f cli/demo/sample-kubernetes.eval.ts -a demo
```
