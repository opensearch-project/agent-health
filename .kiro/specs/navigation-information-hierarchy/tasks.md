# Navigation and Information Hierarchy - Implementation Tasks

## Task List

- [x] 1. Update Layout Component Navigation Structure
  - [x] 1.1 Rename "Evals" to "Testing" in Layout.tsx
  - [x] 1.2 Reorder sub-items (Benchmarks before Test Cases)
  - [x] 1.3 Update variable names for consistency
  - [x] 1.4 Update test IDs to reflect new naming

- [x] 2. Implement Navigation Tooltips
  - [x] 2.1 Add tooltip text to all navigation items
  - [x] 2.2 Ensure tooltips work in collapsed sidebar mode
  - [x] 2.3 Verify tooltip accessibility

- [ ] 3. Update Tests
  - [ ] 3.1 Update unit tests for Layout component
  - [ ] 3.2 Update integration tests for navigation
  - [ ] 3.3 Update test IDs in test files

- [ ] 4. Verify and Test
  - [ ] 4.1 Manual testing in development
  - [ ] 4.2 Verify all routes still work
  - [ ] 4.3 Test keyboard navigation
  - [ ] 4.4 Test screen reader compatibility

- [ ] 5. Documentation
  - [ ] 5.1 Update component documentation
  - [ ] 5.2 Update user-facing documentation (if needed)

## Task Details

### 1. Update Layout Component Navigation Structure

**File:** `agent-health-jasonlh/components/Layout.tsx`

**Changes:**
1. Rename section from "Evals" to "Testing"
2. Reorder `evalsSubItems` array to put Benchmarks first
3. Update variable names:
   - `evalsOpen` → `testingOpen`
   - `isEvalsPath` → `isTestingPath`
   - `evalsSubItems` → `testingSubItems`
4. Update test IDs:
   - `nav-evals` → `nav-testing`

**Acceptance Criteria:**
- Navigation renders with "Testing" label instead of "Evals"
- Benchmarks appears before Test Cases in the sub-menu
- All variable names are consistent with new naming
- Test IDs are updated throughout

### 1.1 Rename "Evals" to "Testing" in Layout.tsx

**Implementation:**
- Update the collapsible section label from "Evals" to "Testing"
- Update tooltip text to "Testing"
- Update collapsed state link to use "Testing" terminology

**Acceptance Criteria:**
- "Testing" label appears in navigation
- Tooltip shows "Testing" when sidebar is collapsed
- No references to "Evals" remain in the component

### 1.2 Reorder sub-items (Benchmarks before Test Cases)

**Implementation:**
- Reorder the `evalsSubItems` array to:
  ```typescript
  const testingSubItems = [
    { to: "/benchmarks", label: "Benchmarks", testId: "nav-benchmarks" },
    { to: "/test-cases", label: "Test Cases", testId: "nav-test-cases" },
  ];
  ```

**Acceptance Criteria:**
- Benchmarks appears first in the Testing sub-menu
- Test Cases appears second in the Testing sub-menu
- Order is consistent in both expanded and collapsed states

### 1.3 Update variable names for consistency

**Implementation:**
- Rename `evalsOpen` to `testingOpen`
- Rename `isEvalsPath` to `isTestingPath`
- Rename `evalsSubItems` to `testingSubItems`
- Update all references to these variables throughout the component

**Acceptance Criteria:**
- All variable names use "testing" instead of "evals"
- No compilation errors
- Functionality remains unchanged

### 1.4 Update test IDs to reflect new naming

**Implementation:**
- Update `data-testid="nav-evals"` to `data-testid="nav-testing"`
- Ensure sub-item test IDs remain unchanged (nav-benchmarks, nav-test-cases)

**Acceptance Criteria:**
- Test ID for Testing section is "nav-testing"
- Sub-item test IDs remain unchanged
- Tests can locate elements by new test IDs

### 2. Implement Navigation Tooltips

**Files:** `agent-health-jasonlh/components/Layout.tsx`

**Changes:**
1. Add tooltip text to all navigation items
2. Ensure tooltips appear correctly in collapsed mode
3. Verify accessibility attributes

**Tooltip Content:**
- Overview: "Dashboard and quick stats"
- Agent Traces: "View and debug agent executions"
- Testing: "Benchmarks and test cases"
- Benchmarks: "Define success criteria and scoring"
- Test Cases: "Create and manage test inputs"
- Settings: "Configure connections and preferences"

**Acceptance Criteria:**
- All navigation items have tooltips
- Tooltips appear on hover in collapsed mode
- Tooltips are accessible via keyboard
- Tooltip text is clear and concise

### 2.1 Add tooltip text to all navigation items

**Implementation:**
- Add tooltip prop to each navigation item in `navItems` array
- Add tooltip prop to each item in `testingSubItems` array
- Add tooltip to Settings item
- Ensure tooltips only show when sidebar is collapsed (except for sub-items)

**Acceptance Criteria:**
- All navigation items have tooltip text defined
- Tooltips display correct content
- Tooltips follow design specifications

### 2.2 Ensure tooltips work in collapsed sidebar mode

**Implementation:**
- Verify tooltip prop is passed to SidebarMenuButton components
- Test tooltip display when sidebar is collapsed
- Ensure tooltips don't show when sidebar is expanded (except where specified)

**Acceptance Criteria:**
- Tooltips appear when hovering over collapsed navigation items
- Tooltips position correctly to the right of the sidebar
- Tooltips don't overlap with other UI elements

### 2.3 Verify tooltip accessibility

**Implementation:**
- Ensure tooltips have proper ARIA attributes
- Test keyboard navigation to tooltips
- Test screen reader announcement of tooltips

**Acceptance Criteria:**
- Tooltips are keyboard accessible
- Screen readers announce tooltip content
- Tooltips meet WCAG 2.1 AA standards

### 3. Update Tests

**Files:** Test files related to Layout component

**Changes:**
1. Update test IDs in test files
2. Update assertions for new navigation structure
3. Add tests for tooltip functionality

**Acceptance Criteria:**
- All tests pass
- Test coverage maintained or improved
- No flaky tests introduced

### 3.1 Update unit tests for Layout component

**Implementation:**
- Update test IDs from "nav-evals" to "nav-testing"
- Update assertions for "Testing" label instead of "Evals"
- Update assertions for sub-item order (Benchmarks first)
- Add tests for tooltip presence and content

**Acceptance Criteria:**
- All unit tests pass
- Tests verify new navigation structure
- Tests verify tooltip functionality

### 3.2 Update integration tests for navigation

**Implementation:**
- Update E2E tests that reference "Evals" navigation
- Verify navigation flows still work correctly
- Test deep linking to Benchmarks and Test Cases pages

**Acceptance Criteria:**
- All integration tests pass
- Navigation flows work as expected
- Deep links continue to work

### 3.3 Update test IDs in test files

**Implementation:**
- Search for all references to "nav-evals" test ID
- Replace with "nav-testing"
- Verify no broken test selectors

**Acceptance Criteria:**
- All test files updated
- No references to old test IDs remain
- Tests can locate elements correctly

### 4. Verify and Test

**Manual Testing Checklist:**

**Acceptance Criteria:**
- All manual tests pass
- No regressions identified
- User experience is smooth

### 4.1 Manual testing in development

**Test Cases:**
1. Navigate to each page using the new navigation
2. Verify "Testing" label appears instead of "Evals"
3. Verify Benchmarks appears before Test Cases
4. Expand and collapse the Testing section
5. Test in both light and dark modes
6. Test with sidebar expanded and collapsed
7. Verify tooltips appear on hover in collapsed mode

**Acceptance Criteria:**
- All navigation items work correctly
- Visual appearance matches design
- No console errors
- Smooth animations and transitions

### 4.2 Verify all routes still work

**Test Cases:**
1. Navigate to `/` (Overview)
2. Navigate to `/agent-traces`
3. Navigate to `/benchmarks`
4. Navigate to `/test-cases`
5. Navigate to `/settings`
6. Test deep links with query parameters
7. Test browser back/forward buttons

**Acceptance Criteria:**
- All routes load correctly
- No 404 errors
- Browser navigation works as expected
- Bookmarks continue to work

### 4.3 Test keyboard navigation

**Test Cases:**
1. Tab through all navigation items
2. Use Enter/Space to activate links
3. Use arrow keys within collapsible sections
4. Test Escape key behavior
5. Verify focus indicators are visible

**Acceptance Criteria:**
- All navigation items are keyboard accessible
- Focus order is logical
- Focus indicators are clearly visible
- Keyboard shortcuts work as expected

### 4.4 Test screen reader compatibility

**Test Cases:**
1. Navigate using screen reader (VoiceOver, NVDA, or JAWS)
2. Verify all labels are announced correctly
3. Verify collapsible state is announced
4. Verify active page is announced
5. Verify tooltips are announced

**Acceptance Criteria:**
- All navigation items are announced correctly
- Collapsible state changes are announced
- Active page is clearly indicated
- Tooltips provide additional context

### 5. Documentation

**Files:** Component documentation, user guides

**Changes:**
1. Update component documentation
2. Update user-facing documentation if needed

**Acceptance Criteria:**
- Documentation reflects new navigation structure
- Screenshots updated if needed
- No outdated references remain

### 5.1 Update component documentation

**Implementation:**
- Update Layout.tsx component documentation
- Update navigation structure diagrams
- Document tooltip implementation

**Acceptance Criteria:**
- Component documentation is accurate
- Code comments are updated
- Architecture diagrams reflect changes

### 5.2 Update user-facing documentation (if needed)

**Implementation:**
- Review user guides for references to "Evals"
- Update screenshots showing navigation
- Update feature location references

**Acceptance Criteria:**
- User documentation is accurate
- Screenshots show current navigation
- No confusing references to old terminology

## Testing Checklist

### Pre-Implementation
- [ ] Review design document
- [ ] Understand current navigation structure
- [ ] Identify all files that need changes

### During Implementation
- [ ] Make changes incrementally
- [ ] Test after each change
- [ ] Commit frequently with clear messages

### Post-Implementation
- [ ] Run all unit tests
- [ ] Run all integration tests
- [ ] Perform manual testing
- [ ] Test accessibility
- [ ] Review code changes
- [ ] Update documentation

### Before Deployment
- [ ] Code review completed
- [ ] All tests passing
- [ ] Documentation updated
- [ ] Rollback plan confirmed

## Notes

- All routes remain unchanged (no URL changes)
- No new dependencies required
- Changes are purely presentational
- Backward compatible with existing bookmarks
- Can be rolled back quickly if needed
