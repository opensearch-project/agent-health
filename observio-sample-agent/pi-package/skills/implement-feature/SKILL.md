---
name: implement-feature
description: >
  Guided feature implementation for Agent Health. Use when a user wants to add a new
  capability, endpoint, CLI command, or UI component to the Agent Health project.
  Ensures correct architecture layer, coding conventions, test coverage, and PR readiness.
---

# Implement Feature in Agent Health

You are helping the user implement a feature in the Agent Health project. Follow the project's architecture and conventions strictly.

## Step 1: Understand the Request

Clarify:
1. What does the feature do? (user-facing behavior)
2. Who triggers it? (UI, CLI, API, background process)
3. What data does it read/write? (OpenSearch indexes, config, files)

## Step 2: Identify the Architecture Layer

Use the `find_architecture` tool to locate where this feature belongs. The layers are:

| Trigger | Implementation Layer | Key Pattern |
|---------|---------------------|-------------|
| HTTP API | `server/routes/` | Route validation, early return 404, `{ error }` responses |
| CLI command | `cli/commands/` | Uses `apiClient.ts` to call server, `ensureServer()` for lifecycle |
| Background work | `services/` | SSE streaming, cancellation tokens, persist state immediately |
| UI interaction | `components/` + `hooks/` | React, shadcn/ui, client service calls |
| Data persistence | `services/storage/` | `asyncXStorage` with `toAppFormat()`/`toStorageFormat()` |
| Agent protocol | `connectors/` | ConnectorType, streaming adapter |

**Critical rule**: All clients access OpenSearch through the server HTTP API. Never bypass the server.

## Step 3: Plan the Implementation

Before writing code, identify:
- **Files to create**: New routes, services, types, tests
- **Files to modify**: Existing types, route registrations, CLI command list
- **Types needed**: Add to `types/index.ts` — use string unions (not enums), discriminated unions with `type` field

### Coding Conventions to Follow

- **Route validation**: `validateX(): string | null`, return 400 early
- **Storage wrappers**: `toAppFormat()`/`toStorageFormat()` conversion
- **SSE streaming**: Set event-stream headers, `res.flushHeaders()`, structured events
- **Cancellation**: `{ isCancelled, cancel() }` token in a Map, check before each iteration
- **Run status**: `pending` → `running` → `completed` | `failed` | `cancelled`
- **Exports**: Barrel exports via `index.ts` with named functions
- **Path alias**: Use `@/` prefix for all imports (maps to project root)
- **Types**: `RunConfigInput` (user fields) vs full entity. String unions not enums.

### What NOT to Do

- Don't add unnecessary error handling for internal code paths
- Don't add docstrings/comments to code you didn't change
- Don't create helpers/abstractions for one-time operations
- Don't add feature flags or backwards-compatibility shims
- Don't modify `package.json` name or version fields

## Step 4: Implement

Write the code following the plan. For each file:

1. Add SPDX header: `/* Copyright OpenSearch Contributors\n SPDX-License-Identifier: Apache-2.0 */`
2. Use `@/` path alias for imports
3. Follow existing patterns in the same directory

### If Adding a Route

```typescript
// server/routes/myFeature.ts
import { Router } from 'express';

const router = Router();

function validateInput(body: any): string | null {
  if (!body.requiredField) return 'requiredField is required';
  return null;
}

router.post('/api/my-feature', async (req, res) => {
  const error = validateInput(req.body);
  if (error) return res.status(400).json({ error });
  // ...implementation
});

export default router;
```

### If Adding a CLI Command

```typescript
// cli/commands/myCommand.ts
// Uses apiClient — NEVER calls OpenSearch directly
import { apiClient } from '../utils/apiClient';
import { ensureServer } from '../utils/serverLifecycle';

export async function myCommand(args: any) {
  await ensureServer();
  const result = await apiClient.get('/api/my-feature');
  // ...
}
```

### If Adding a Storage Entity

```typescript
// services/storage/asyncMyStorage.ts
// Follow the asyncTestCaseStorage.ts pattern exactly
export const asyncMyStorage = {
  async create(entity: MyType): Promise<MyType> { /* ... */ },
  async get(id: string): Promise<MyType | null> { /* ... */ },
  async update(id: string, updates: Partial<MyType>): Promise<MyType> {
    // MUST throw if entity doesn't exist (no upsert)
  },
  async delete(id: string): Promise<void> { /* ... */ },
  async list(): Promise<MyType[]> { /* ... */ },
};
```

## Step 5: Write Tests

Use the `/write-test` skill or follow these rules:
- Place tests in `tests/` mirroring source structure
- Use `@/` path alias, never relative imports
- Coverage thresholds: 90% lines/statements, 80% functions/branches
- Mock external services (OpenSearch, Bedrock), not internal modules
- Integration tests that create data MUST clean up in `afterEach`/`afterAll`

## Step 6: Validate

Run `run_validation` tool with scope "all" to verify:
- TypeScript compiles cleanly (`npm run build:all`)
- All tests pass (`npm run test:all`)
- No coverage regression

## Step 7: Prepare PR

Use `check_compliance` tool to verify:
- [ ] SPDX headers on all new files
- [ ] CHANGELOG.md updated
- [ ] All commits have DCO signoff (`git commit -s`)
- [ ] Build passes, tests pass
- [ ] No `--no-verify` bypasses

Then create the PR following the project template:
```
## Summary
- <1-3 bullet points of what changed>

## Test plan
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual verification steps
```
