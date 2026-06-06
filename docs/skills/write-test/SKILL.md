---
name: write-test
description: Use when writing, modifying, or debugging tests. Provides project-specific test conventions, mocking patterns, import rules, and integration test cleanup requirements.
---

## Test Conventions

**File naming:** `<module-name>.test.ts` in `tests/unit/<path-mirroring-source>/`

**Required header:**
```typescript
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */
```

**Basic structure:**
```typescript
import { functionToTest } from '@/path/to/module';

jest.mock('@/services/storage/opensearchClient', () => ({
  benchmarkStorage: { getAll: jest.fn(), getById: jest.fn() },
}));

describe('ModuleName', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('functionToTest', () => {
    it('should handle normal case', () => {
      const result = functionToTest('test');
      expect(result).toBe('expected');
    });
  });
});
```

## Import Conventions

**Always use `@/` path alias** — never relative paths like `../`:

| Module | Import Path |
|--------|-------------|
| Types | `@/types` |
| Server routes | `@/server/routes/<name>` |
| Server services | `@/server/services/<name>` |
| Frontend services | `@/services/<category>/<name>` |
| Lib utilities | `@/lib/<name>` |
| CLI commands | `@/cli/commands/<name>` |

## Mocking Patterns

**Mock external modules:**
```typescript
jest.mock('@/services/storage/opensearchClient', () => ({
  benchmarkStorage: {
    getAll: jest.fn().mockResolvedValue([]),
    getById: jest.fn().mockResolvedValue(null),
  },
  isStorageConfigured: true,
}));
```

**Mock with type safety:**
```typescript
const mockStorage = benchmarkStorage as jest.Mocked<typeof benchmarkStorage>;
mockStorage.getAll.mockResolvedValue([mockBenchmark]);
```

**Dynamic require for module re-import:**
```typescript
jest.resetModules();
process.env.MY_VAR = 'new-value';
const { myConfig } = require('@/lib/config');
```

**Suppress console:** `jest.spyOn(console, 'log').mockImplementation(() => {});`

## Async & SSE Testing

```typescript
// Async
mockFetch.mockResolvedValue({ data: 'test' });
const result = await fetchData();

// Error
await expect(fetchData()).rejects.toThrow('Network error');

// SSE stream
const mockReader = {
  read: jest.fn()
    .mockResolvedValueOnce({ done: false, value: encoder.encode('data: {"type":"start"}\n\n') })
    .mockResolvedValueOnce({ done: true }),
};
```

## Global Mocks (`__mocks__/`)

Modules using `import.meta.url` or browser-only APIs need global mocks via `__mocks__/` + `moduleNameMapper` in `jest.config.cjs`:
- `__mocks__/@/lib/config.ts`, `__mocks__/@/server/services/configService.ts`, `__mocks__/@/server/utils/version.ts`
- `__mocks__/dagre.ts`, `__mocks__/xyflow-react.ts`

## Test Categories

**Unit tests** (`tests/unit/`): Mock ALL dependencies, <100ms per test, no network/filesystem.

**Integration tests** (`tests/integration/`): Real services, `*.integration.test.ts`, 30s timeout. **Always clean up in `afterAll`:**
```typescript
const createdTestCaseIds: string[] = [];
const createdBenchmarkIds: string[] = [];

afterAll(async () => {
  for (const id of createdTestCaseIds) {
    await fetch(`${BASE_URL}/api/storage/test-cases/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
  for (const id of createdBenchmarkIds) {
    await fetch(`${BASE_URL}/api/storage/benchmarks/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }
});
```

## Coverage Thresholds

Lines: 90%, Statements: 90%, Functions: 80%, Branches: 80%
