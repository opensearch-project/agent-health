---
name: create-pr
description: Prepare and create a pull request against the upstream repository with all OpenSearch project compliance checks.
disable-model-invocation: true
argument-hint: "[branch-name]"
---

## PR Workflow for opensearch-project/agent-health

**IMPORTANT:** PRs are created from your personal fork, NOT from branches on `opensearch-project/agent-health` directly. Push to your fork remote (e.g., `fork` or your GitHub username), then open a PR targeting `opensearch-project/agent-health:main`.

**MANDATORY:** Every commit MUST have DCO (Developer Certificate of Origin) signoff. Always use `git commit -s`. CI will reject commits without signoff. Never use `--no-verify` to bypass this.

### 1. Fetch latest and create branch
```bash
git fetch origin main
git checkout -b <branch-name> origin/main
```

### 2. Cherry-pick commits (if from a dev branch)
```bash
git cherry-pick <oldest-commit>^..<newest-commit>
```

### 3. Verify DCO sign-off on ALL commits
```bash
git log --format="%h %s" origin/main..HEAD
git log origin/main..HEAD | grep -c "Signed-off-by"
# If missing: git rebase origin/main --signoff
```

### 4. Add changelog entry (REQUIRED — CI will fail without this)
Update `CHANGELOG.md` under `## [Unreleased]` with appropriate category (`Added`, `Changed`, `Fixed`, `Removed`, `Security`). Include PR link:
```markdown
### Added
- Description of change ([#PR](https://github.com/opensearch-project/agent-health/pull/PR))
```

### 5. Run pre-PR checks (ALL must pass)
```bash
npm run build:all && npm run test:all
npm audit --audit-level=high
```

### 6. Pre-PR Checklist
- [ ] All commits have DCO signoff
- [ ] `CHANGELOG.md` updated under `## [Unreleased]` with PR link
- [ ] `npm run build:all` succeeds
- [ ] `npm run test:all` passes (unit + integration + e2e)
- [ ] `npm audit --audit-level=high` reports no vulnerabilities
- [ ] New source files have SPDX license headers
- [ ] No secrets committed (`.env`, credentials, tokens)

### 7. Push to your fork and create PR
```bash
# Push to your personal fork (NOT opensearch-project directly)
git push -u fork <branch-name>
# Create PR targeting the upstream repo
gh pr create --repo opensearch-project/agent-health --base main
```

### License Headers (for new files)
```typescript
// .ts, .tsx, .js, .jsx, .cjs, .mjs, .css:
/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */
```

### DCO Signoff
All commits need `-s` flag: `git commit -s -m "message"`
Signoff: `Signed-off-by: Megha Goyal <goyamegh@amazon.com>`
