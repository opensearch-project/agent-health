---
name: fix-bug
description: >
  Diagnose and fix bugs in Agent Health. Use when a user reports a bug, failing test,
  or unexpected behavior. Follows a systematic diagnosis → fix → verify workflow.
---

# Fix Bug in Agent Health

You are helping the user diagnose and fix a bug in Agent Health.

## Step 1: Reproduce & Locate

1. **Understand the symptom**: What's the expected vs actual behavior?
2. **Identify the layer**: Use `find_architecture` tool to narrow down where the bug likely lives
3. **Find the code path**: Trace from the trigger (UI action, CLI command, API call) through the layers

### Common Bug Locations by Symptom

| Symptom | Likely Location |
|---------|----------------|
| Traces not appearing | `services/traces/tracePoller.ts`, `spanCategorization.ts` |
| Wrong token/cost metrics | `services/traces/metrics.ts` |
| Storage errors | `services/storage/async*Storage.ts`, `server/adapters/` |
| CLI command fails | `cli/commands/`, `cli/utils/apiClient.ts` |
| SSE stream drops | `services/agent/sseHandler.ts`, response flushing |
| Evaluation incorrect | `server/routes/judge.ts`, prompt templates |
| UI not updating | `hooks/`, `services/client/` |
| Agent connector fails | `connectors/`, connector-specific adapter |

## Step 2: Diagnose

Read the relevant code. Look for:
- Off-by-one errors in iteration/pagination
- Missing null checks at system boundaries (API responses, storage queries)
- Race conditions in async flows (SSE, polling, cancellation)
- Type mismatches between storage format and app format
- Incorrect OpenSearch query construction

**Do NOT guess.** Read the code, understand the flow, then identify the root cause.

## Step 3: Fix

Apply the minimal fix:
- Fix the actual bug, don't refactor surrounding code
- Don't add defensive error handling for scenarios that can't happen
- Don't add comments explaining the fix (the commit message does that)
- If the fix touches a type, check all usages of that type

## Step 4: Write a Regression Test

Every bug fix should have a test that would have caught it:
- Test the specific scenario that was broken
- Use `@/` path alias
- Place in `tests/` mirroring the source path

## Step 5: Verify

1. Run `run_validation` tool (scope: "all")
2. Manually verify the original symptom is resolved
3. Check that no other tests broke (the fix didn't introduce regressions)

## Step 6: Commit & PR

```bash
git commit -s -m "fix: <concise description of what was wrong>

<one line explaining root cause>"
```

Update CHANGELOG.md under the appropriate section.
