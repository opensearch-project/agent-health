# Navigation and Information Hierarchy - Design Document

## Overview
This design implements a refined navigation structure that optimizes for return users while improving clarity through better labeling and grouping. The changes are minimal and non-disruptive, preserving existing workflows and muscle memory.

## Design Principles

1. **Minimal Disruption:** Preserve existing navigation patterns and routes
2. **Clear Labeling:** Use terminology that matches user mental models
3. **Progressive Disclosure:** Help through structure and tooltips, not blocking UI
4. **Preserve Performance:** Maintain 30-second time-to-value for all users

## Navigation Structure

### Current Structure
```
├── Overview (Dashboard)
├── Agent Traces
├── Evals (Collapsible)
│   ├── Test Cases
│   └── Benchmarks
└── Settings
```

### New Structure
```
├── Overview (Dashboard)
├── Agent Traces
├── Testing (Collapsible, expanded by default)
│   ├── Benchmarks
│   └── Test Cases
└── Settings
```

### Changes Summary
1. Rename "Evals" → "Testing" (clearer terminology)
2. Reorder sub-items: Benchmarks before Test Cases (logical flow)
3. Add descriptive tooltips to all navigation items
4. Maintain expanded-by-default state

## Component Changes

### 1. Layout Component (`components/Layout.tsx`)

#### Changes Required:
1. Update section label from "Evals" to "Testing"
2. Reorder `evalsSubItems` array (Benchmarks first, then Test Cases)
3. Add tooltip text to all navigation items
4. Update test IDs to reflect new naming

#### Implementation Details:

**Navigation Items with Tooltips:**
```typescript
const navItems = [
  { 
    to: "/", 
    icon: LayoutDashboard, 
    label: "Overview",
    tooltip: "Dashboard and quick stats",
    testId: "nav-overview" 
  },
  { 
    to: "/agent-traces", 
    icon: Table2, 
    label: "Agent Traces",
    tooltip: "View and debug agent executions",
    testId: "nav-agent-traces" 
  },
];

const testingSubItems = [
  { 
    to: "/benchmarks", 
    label: "Benchmarks",
    tooltip: "Define success criteria and scoring",
    testId: "nav-benchmarks" 
  },
  { 
    to: "/test-cases", 
    label: "Test Cases",
    tooltip: "Create and manage test inputs",
    testId: "nav-test-cases" 
  },
];
```

**Testing Section (renamed from Evals):**
```typescript
<SidebarMenuItem>
  <CollapsibleTrigger asChild>
    <SidebarMenuButton
      tooltip="Testing"
      isActive={isTestingPath}
      className="h-9 w-full"
    >
      <TestTube className="h-4 w-4" />
      <span className="text-sm">Testing</span>
      <ChevronDown 
        className={`ml-auto h-4 w-4 transition-transform duration-200 ${
          testingOpen ? 'rotate-180' : ''
        }`} 
      />
    </SidebarMenuButton>
  </CollapsibleTrigger>
  <CollapsibleContent>
    <SidebarMenuSub className="ml-4 mt-1 space-y-1">
      {testingSubItems.map((item) => (
        <SidebarMenuSubItem key={item.to}>
          <SidebarMenuSubButton
            asChild
            isActive={location.pathname === item.to || location.pathname.startsWith(item.to + "/")}
            data-testid={item.testId}
            className="h-8"
            tooltip={item.tooltip}
          >
            <Link to={item.to} className="text-sm">{item.label}</Link>
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  </CollapsibleContent>
</SidebarMenuItem>
```

**Settings with Tooltip:**
```typescript
<SidebarMenuItem>
  <SidebarMenuButton
    asChild
    isActive={location.pathname === "/settings"}
    tooltip={isCollapsed ? "Settings" : "Configure connections and preferences"}
    data-testid="nav-settings"
    className="h-9"
  >
    <Link to="/settings" className={isCollapsed ? 'justify-center' : ''}>
      <Settings className="h-4 w-4" />
      {!isCollapsed && <span className="text-sm">Settings</span>}
    </Link>
  </SidebarMenuButton>
</SidebarMenuItem>
```

#### Variable Naming Updates:
- `evalsOpen` → `testingOpen`
- `isEvalsPath` → `isTestingPath`
- `evalsSubItems` → `testingSubItems`

### 2. Tooltip Implementation

Tooltips should:
- Appear on hover after 500ms delay
- Be positioned to the right of navigation items
- Use consistent styling from the UI library
- Be accessible (keyboard navigable, screen reader friendly)
- Not appear when sidebar is expanded (except for Settings)

**Tooltip Content:**
- **Overview:** "Dashboard and quick stats"
- **Agent Traces:** "View and debug agent executions"
- **Testing:** "Benchmarks and test cases"
- **Benchmarks:** "Define success criteria and scoring"
- **Test Cases:** "Create and manage test inputs"
- **Settings:** "Configure connections and preferences"

### 3. State Management

**Path Detection:**
```typescript
const isTestingPath = location.pathname.startsWith("/test-cases") ||
                      location.pathname.startsWith("/benchmarks");
```

**Default State:**
```typescript
const [testingOpen, setTestingOpen] = useState(true); // Expanded by default
```

## Visual Design

### Spacing and Hierarchy
- Main nav items: 36px height (h-9)
- Sub-items: 32px height (h-8)
- Sub-item indentation: 16px (ml-4)
- Vertical spacing: 4px between items (space-y-1)

### Typography
- Main items: text-sm (14px)
- Sub-items: text-sm (14px)
- Tooltips: text-xs (12px)

### Icons
- All icons: 16x16px (h-4 w-4)
- Maintain existing icon choices:
  - Overview: LayoutDashboard
  - Agent Traces: Table2
  - Testing: TestTube
  - Settings: Settings

### Colors
- Active state: Existing accent color
- Hover state: Existing hover background
- Tooltip background: Existing tooltip styling
- No new color additions required

## Accessibility

### Keyboard Navigation
- Tab through navigation items
- Enter/Space to activate links
- Arrow keys to navigate within collapsible sections
- Escape to close tooltips

### Screen Readers
- All navigation items have proper labels
- Tooltips are announced when focused
- Collapsible state is announced ("expanded" / "collapsed")
- Active page is announced

### ARIA Attributes
```typescript
<SidebarMenuButton
  aria-label="Testing section"
  aria-expanded={testingOpen}
  aria-controls="testing-submenu"
>
```

## Testing Strategy

### Unit Tests
1. Navigation items render in correct order
2. Tooltips appear with correct text
3. Collapsible section expands/collapses correctly
4. Active states apply correctly
5. Variable names updated throughout

### Integration Tests
1. Navigation between pages works correctly
2. Deep links to sub-pages work
3. Browser back/forward buttons work
4. Bookmarks continue to work

### Visual Regression Tests
1. Sidebar appearance in expanded state
2. Sidebar appearance in collapsed state
3. Tooltip positioning and styling
4. Active state highlighting
5. Dark mode compatibility

### User Acceptance Tests
1. Return users can navigate to familiar pages without confusion
2. New users understand section purposes from labels and tooltips
3. No increase in navigation errors
4. Time to primary destination maintained or improved

## Migration Strategy

### Phase 1: Code Changes
1. Update Layout.tsx with new structure
2. Update variable names for consistency
3. Add tooltip implementation
4. Update test IDs

### Phase 2: Testing
1. Run unit tests
2. Run integration tests
3. Manual testing in dev environment
4. Visual regression testing

### Phase 3: Deployment
1. Deploy to staging environment
2. Internal team testing
3. Monitor analytics for navigation patterns
4. Deploy to production with feature flag (optional)

### Phase 4: Monitoring
1. Track navigation metrics
2. Monitor error rates
3. Collect user feedback
4. Iterate based on data

## Rollback Plan

If metrics show regression:
1. Revert Layout.tsx changes
2. Restore original variable names
3. Remove tooltip implementation
4. Redeploy previous version

Rollback can be completed in < 5 minutes.

## Performance Considerations

### Bundle Size
- No new dependencies required
- Tooltip component already exists in UI library
- Estimated impact: < 1KB

### Runtime Performance
- No additional API calls
- No new state management overhead
- Tooltip rendering is lazy (on hover only)
- No impact on page load time

## Browser Compatibility

- Chrome 90+ ✓
- Firefox 88+ ✓
- Safari 14+ ✓
- Edge 90+ ✓

All modern browsers support the required CSS and JavaScript features.

## Documentation Updates

### User Documentation
- Update navigation screenshots
- Update "Getting Started" guide
- Update feature location references

### Developer Documentation
- Update component documentation
- Update test documentation
- Update architecture diagrams

## Success Criteria

### Must Have (P0)
- ✓ Navigation items render in new order
- ✓ "Testing" label replaces "Evals"
- ✓ Benchmarks appears before Test Cases
- ✓ All existing routes continue to work
- ✓ No visual regressions

### Should Have (P1)
- ✓ Tooltips appear on all navigation items
- ✓ Tooltips are accessible
- ✓ Variable names are consistent
- ✓ Tests pass

### Nice to Have (P2)
- Analytics show improved discoverability
- User feedback is positive
- Support questions decrease

## Open Questions

None - all decisions have been made in requirements phase.

## Appendix

### Related Files
- `components/Layout.tsx` - Main navigation component
- `components/ui/sidebar.tsx` - Sidebar UI components
- `components/ui/tooltip.tsx` - Tooltip component

### Related Routes
- `/` - Overview page
- `/agent-traces` - Agent Traces page
- `/benchmarks` - Benchmarks page
- `/test-cases` - Test Cases page
- `/settings` - Settings page

### Test Files to Update
- `components/Layout.test.tsx` (if exists)
- E2E navigation tests
- Visual regression test baselines
