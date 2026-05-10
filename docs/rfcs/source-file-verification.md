# RFC: Source File Verification for Code-Sourced Test Cases

## Status: Proposed

## Context

The Test Case SDK stores a `source.file` path on each code-sourced test case. This path establishes a **contract** between benchmark users and Agent Health — the file IS the source of truth.

At runtime (UI/server), we must verify that the source file still exists:
- **File exists** → normal experience, runs allowed, source verified
- **File missing** → read-only, runs blocked, warning shown
- **User override** → confirm to run with "last snapshot" (stored data), acknowledging staleness

## Design

### Server: Source verification endpoint

**`GET /api/storage/test-cases/:id/verify-source`**

Checks if `source.file` exists on the server's filesystem (relative to `process.cwd()`).

```typescript
// Response
{
  verified: boolean;      // true if file exists at source.file path
  source: TestCaseSource; // the stored source metadata
  filePath: string;       // resolved path checked
}
```

### Batch verification

**`POST /api/storage/test-cases/verify-sources`**

```typescript
// Request
{ ids: string[] }

// Response
{ results: Record<string, boolean> }
```

Verifies multiple test cases at once (called on page load for all code-sourced cases).

### UI: Gated Run experience

1. **Run button** triggers verification for code-sourced test cases:
   - `verified: true` → open QuickRunModal normally
   - `verified: false` → show confirmation dialog:
     > "Source file not found at `evals/k8s.eval.ts`. The test case data may be stale."
     > [Cancel] [Run Anyway]

2. **Badge variants**:
   - Verified: teal "Code" badge
   - Stale/missing: amber "⚠ Code" badge

3. **Edit button** — remains hidden for code-sourced (regardless of file presence)

### Data flow

```
User clicks "Run" on code-sourced test case
  → Frontend calls GET /verify-source
  → Server checks existsSync(source.file)
  → If exists: proceed to QuickRunModal
  → If missing: show confirmation dialog
    → "Run Anyway": proceed with stored data
    → "Cancel": nothing happens
```

## Files to Create/Modify

| File | Change |
|------|--------|
| `server/routes/storage/testCases.ts` | Add verify-source endpoint |
| `components/evals3/TestCasesPage.tsx` | Verification before run, stale badge, confirmation dialog |
| `services/client/` or hooks | `verifySource()` API call |

## Verification

1. Import via `benchmark -f evals.ts` → test case with `source.file` → teal badge → Run works
2. Delete `.eval.ts` → reload → amber badge → Run shows confirmation → "Run Anyway" uses snapshot
3. Restore file → reload → teal badge → normal
4. Managed test cases → unaffected
