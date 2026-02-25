# PR Split Plan & Conflict Analysis

## Executive Summary

Breaking `trace-info-behavior-improvements` branch into 3 focused PRs to improve reviewability and reduce merge risk.

**Total Changes**: 99 files, 13,902 insertions, 375 deletions
**Conflicts Detected**: 2 files (minor, easily resolvable)
**Branch Status**: 19 commits ahead of main, main is 9 commits ahead (already merged in PR #2)

---

## Conflict Analysis

### Files with Merge Conflicts

#### 1. `components/Layout.tsx`
- **Conflict Type**: Import statement changes
- **Your Branch**: Removed unused menu search feature (commit `30c6d33`)
- **Main Branch**: Has different import organization from PR #2
- **Resolution**: Keep your changes (newer, removes unused code)
- **Risk**: LOW - Simple import conflict

#### 2. `components/traces/AgentTracesPage.tsx`
- **Conflict Type**: Import additions and component structure
- **Your Branch**: Added sorting, filtering, search enhancements (commits `a4dd27c` through `5c73bec`)
- **Main Branch**: Has earlier version from PR #2
- **Resolution**: Keep your changes (superset of main's changes)
- **Risk**: LOW - Your changes are additive and newer

### Conflict Resolution Strategy

Both conflicts favor **your branch** because:
1. Your commits are chronologically newer (Feb 24, 2026)
2. Main's conflicting changes were from PR #2 which was merged earlier
3. Your changes are additive/improvements, not replacements
4. No functional logic conflicts, only structural/import differences

---

## PR Split Strategy

### PR #1: Agent Traces Table Enhancements
**Branch**: `feat/agent-traces-table-improvements`
**Priority**: HIGH (Core functionality)
**Size**: ~15 files

#### Commits to Include
- `a4dd27c` - Add sortable columns to Agent Traces table
- `7079359` - Persist filter selections across sessions
- `b00519f` - Make search input more prominent
- `30c6d33` - Remove unused menu search feature
- `e92122c` - Enhance search visibility and add service search
- `f0ae7f8` - Add legend to latency distribution chart
- `c3fade7` - Enhance search box visual prominence
- `d93d64d` - Use bright blue icon and white placeholder
- `a0f2ce0` - Adjust placeholder text for light mode
- `5c73bec` - Refine search box styling for both themes

#### Files Changed
```
components/traces/AgentTracesPage.tsx
components/traces/MetricsOverview.tsx
components/Layout.tsx
server/services/tracesService.ts
```

#### Features
- Sortable table columns with visual indicators
- Persistent filter state (localStorage)
- Enhanced search with service name support
- Improved search box visibility (bright blue icon, better contrast)
- Latency distribution legend
- Removed unused menu search

#### Testing Checklist
- [ ] Sort by each column (ascending/descending)
- [ ] Filter persistence across navigation
- [ ] Search functionality (traces, services, spans)
- [ ] Search box visibility in light/dark mode
- [ ] Legend displays correctly

---

### PR #2: Dashboard & First-Run Experience
**Branch**: `feat/dashboard-first-run-experience`
**Priority**: MEDIUM (User onboarding)
**Size**: ~25 files

#### Commits to Include
- `d34755b` - Add design specs for navigation hierarchy
- `4e29e0d` - Add workflow navigator card
- `9350581` - Add guided onboarding and sample data workflow
- `4c1ef78` - Add dismissible workflow card with chart expansion

#### Files Changed
```
components/Dashboard.tsx
components/dashboard/FirstRunExperience.tsx
components/dashboard/WorkflowNavigator.tsx
components/dashboard/WorkflowNavigatorFirstRun.tsx
components/dashboard/MetricsTable.tsx
config/sampleData.ts
hooks/useDataState.ts
public/test-first-run-improved.html
.kiro/specs/first-run-experience/*
.kiro/specs/dashboard-workflow-navigator/*
.kiro/specs/navigation-information-hierarchy/*
```

#### Features
- First-run guided onboarding experience
- Workflow navigator card with dismissible state
- Sample data for new users
- Full-width chart expansion
- Improved dashboard layout

#### Testing Checklist
- [ ] First-run experience displays for new users
- [ ] Workflow navigator dismissible state persists
- [ ] Sample data loads correctly
- [ ] Chart expansion works
- [ ] Dashboard responsive layout

---

### PR #3: UI Cleanup & Style Consistency
**Branch**: `feat/ui-style-consistency`
**Priority**: LOW (Polish)
**Size**: ~20 files

#### Commits to Include
- `c5348f2` - Remove card shadows and reduce border radius
- `a74719a` - Add test server script
- `025c28c` - Wrap up UI fixes

#### Files Changed
```
components/ui/card.tsx
components/BenchmarkRunsPage.tsx
components/BenchmarksPage.tsx
components/RunDetailsContent.tsx
components/RunDetailsPage.tsx
components/RunSummaryPanel.tsx
components/TrajectoryCompareView.tsx
components/charts/AgentTrendChart.tsx
components/comparison/RunSummaryTable.tsx
components/traces/AgentMapView.tsx
components/traces/TraceFlyoutContent.tsx
components/traces/TraceFullScreenView.tsx
components/traces/TraceInfoView.tsx
components/traces/TraceVisualization.tsx
components/traces/ViewToggle.tsx
test-server.js
.kiro/specs/ui-cleanup/*
```

#### Features
- Consistent card styling (no shadows, reduced border radius)
- OpenSearch Dashboards visual alignment
- Test server for backend validation
- WCAG color compliance improvements

#### Testing Checklist
- [ ] All cards have consistent styling
- [ ] No visual regressions
- [ ] Test server runs correctly
- [ ] Color contrast meets WCAG standards

---

## Documentation Files to Keep

### Essential Documentation (Include in PRs)
- `CHANGELOG.md` - Update with PR-specific changes
- `README.md` - If modified
- `GETTING_STARTED.md` - If modified

### Spec Files (Keep in respective PRs)
- `.kiro/specs/*` - Design documentation for each feature
- Include in the PR that implements the feature

### Working Documentation (Exclude from PRs)
These are development artifacts and should NOT be in PRs:
- `AGENT_TRACE_FLYOUT_BEHAVIOR.md`
- `AGENT_TRACE_FLYOUT_BEHAVIOR_STATUS.md`
- `BENCHMARK_TRACES_TAB_FIX_FINAL_REPORT.md`
- `BRANCH_SETUP_COMPLETE.md`
- `BRANCH_WORK_ANALYSIS.md`
- `CHROME_DEVTOOLS_TEST_REPORT.md`
- `CONFLICT_ANALYSIS.md`
- `DASHBOARD_IMPROVEMENTS_SUMMARY.md`
- `FINAL_TEST_SUMMARY.md`
- `FIRST_RUN_EXPERIENCE_TEST_RESULTS.md`
- `FIRST_RUN_IA_IMPROVEMENTS_SUMMARY.md`
- `FIRST_RUN_ICONS_FIX_COMPLETE.md`
- `FIRST_RUN_IMPROVED_IA_TEST_RESULTS.md`
- `FULLSCREEN_FIXES_APPLIED.md`
- `IMPLEMENTATION_COMPLETE.md`
- `PR_DESCRIPTION.md`
- `RESPONSIVE_LAYOUT_VERIFICATION.md`
- `STATE_PRESERVATION_VERIFICATION.md`
- `TASK_5_VERIFICATION.md`
- `TESTING_SUMMARY.md`
- `VERIFICATION_TASKS_8-12.md`
- `WCAG_COLOR_FIXES_COMPLETE.md`
- `pr-description.md`
- `pr-screenshots/*` (unless needed for PR description)
- `test-screenshots/*`
- `.swp` files

**Action**: Create a `.gitignore` entry or remove these before creating PRs

---

## Implementation Steps

### Step 1: Create PR #1 Branch (Agent Traces Table)
```bash
cd agent-health-jasonlh
git checkout -b feat/agent-traces-table-improvements origin/main
git cherry-pick a4dd27c 7079359 b00519f 30c6d33 e92122c f0ae7f8 c3fade7 d93d64d a0f2ce0 5c73bec
# Resolve conflicts (favor your changes)
git push -u origin feat/agent-traces-table-improvements
```

### Step 2: Create PR #2 Branch (Dashboard & First-Run)
```bash
git checkout -b feat/dashboard-first-run-experience origin/main
git cherry-pick d34755b 4e29e0d 9350581 4c1ef78
git push -u origin feat/dashboard-first-run-experience
```

### Step 3: Create PR #3 Branch (UI Cleanup)
```bash
git checkout -b feat/ui-style-consistency origin/main
git cherry-pick c5348f2 a74719a 025c28c
git push -u origin feat/ui-style-consistency
```

### Step 4: Clean Up Documentation
Before pushing each branch:
```bash
# Remove working documentation files
git rm AGENT_TRACE_FLYOUT_BEHAVIOR.md BRANCH_WORK_ANALYSIS.md CONFLICT_ANALYSIS.md
git rm CHROME_DEVTOOLS_TEST_REPORT.md DASHBOARD_IMPROVEMENTS_SUMMARY.md
git rm FINAL_TEST_SUMMARY.md *_TEST_RESULTS.md *_SUMMARY.md
git rm pr-description.md PR_DESCRIPTION.md
git rm -r pr-screenshots/ test-screenshots/
git commit -m "docs: Remove working documentation files"
```

---

## Risk Assessment

### Overall Risk: LOW

#### Why Low Risk?
1. **Minimal Conflicts**: Only 2 files with simple import/structure conflicts
2. **Chronological Advantage**: Your changes are newer than main's
3. **Additive Changes**: Most changes add features rather than modify existing code
4. **Independent Features**: Each PR is largely independent
5. **Good Test Coverage**: Each PR has clear testing checklist

#### Potential Issues
1. **Cherry-pick Conflicts**: Some commits may have dependencies
   - **Mitigation**: Test each branch thoroughly after cherry-picking
2. **Documentation Noise**: Many .md files add clutter
   - **Mitigation**: Remove working docs before PR
3. **PR Review Time**: 3 PRs will take longer than 1
   - **Mitigation**: PRs are smaller and easier to review

---

## Timeline Recommendation

1. **Week 1**: PR #1 (Agent Traces Table) - Highest value, most user-facing
2. **Week 2**: PR #2 (Dashboard & First-Run) - Improves onboarding
3. **Week 3**: PR #3 (UI Cleanup) - Polish and consistency

Each PR can be reviewed and merged independently.

---

## Next Steps

1. ✅ Review this plan
2. ⬜ Create feat/agent-traces-table-improvements branch
3. ⬜ Cherry-pick commits for PR #1
4. ⬜ Resolve conflicts (favor your changes)
5. ⬜ Remove working documentation
6. ⬜ Test PR #1 thoroughly
7. ⬜ Push and create PR #1
8. ⬜ Repeat for PR #2 and PR #3

---

## Questions?

- Should we merge PRs sequentially or in parallel?
  - **Recommendation**: Sequential (PR #1 → PR #2 → PR #3) to avoid conflicts
- Should we keep any working documentation?
  - **Recommendation**: No, move to separate docs/ folder or wiki
- Should we squash commits in each PR?
  - **Recommendation**: No, keep commit history for traceability
