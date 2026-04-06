# Design Document: Benchmark Traces Tab Fix

## Overview

This design addresses layout and display issues in the Traces tab of the Benchmark page (RunDetailsContent component). The current implementation has several problems:

1. The TraceVisualization component doesn't properly fill the available height in the tab container
2. The default view mode doesn't match the user's expectation (should start with Info view)
3. Layout constraints cause horizontal scrolling and improper panel sizing
4. State synchronization between embedded and fullscreen views is inconsistent

The solution involves:
- Applying proper flexbox layout to the tab container and trace visualization
- Setting the default view mode to "info" for better initial user experience
- Ensuring the TraceVisualization component receives proper height constraints
- Maintaining consistent styling between the Traces tab info view and the trace flyout
- Synchronizing view mode and selected span state between embedded and fullscreen views

## Architecture

### Component Hierarchy

```
RunDetailsContent (Tabs container)
├── TabsContent[value="logs"] (Traces tab)
│   ├── ViewToggle (view mode selector)
│   ├── TraceVisualization (main visualization component)
│   │   ├── TraceInfoView (info mode - default)
│   │   ├── TraceTreeTable (timeline mode)
│   │   ├── TraceTimelineChart (gantt mode)
│   │   ├── AgentMapView (agent-map mode)
│   │   ├── TraceStatsView (stats mode)
│   │   └── SpanDetailsPanel (side panel for selected span)
│   └── TraceFullScreenView (fullscreen modal)
└── Other tabs (summary, trajectory, judge, annotations)
```

### Layout Strategy

The layout uses a nested flexbox approach:

1. **Outer Container** (Tabs): `flex flex-col h-full`
   - Allows tabs to fill parent height
   - Enables proper vertical space distribution

2. **Tab Content** (TabsContent): `flex-1 flex flex-col min-h-0`
   - Takes remaining space after tab headers
   - Enables child components to use percentage heights
   - `min-h-0` prevents flex items from overflowing

3. **Trace Container** (div inside TabsContent): `space-y-4 flex-1 flex flex-col min-h-0`
   - Distributes space to trace visualization
   - Maintains proper scrolling boundaries

4. **Card Wrapper**: `flex-1 flex flex-col min-h-0`
   - Wraps TraceVisualization
   - Ensures visualization fills available space

5. **TraceVisualization**: Receives height through flex parent
   - Internal layout uses `h-full flex flex-col`
   - View content area uses `flex-1 overflow-hidden`
   - Individual views handle their own scrolling

## Components and Interfaces

### Modified Components

#### RunDetailsContent.tsx

**Changes:**
1. Update `traceViewMode` initial state from `'timeline'` to `'info'`
2. Add flex layout classes to Traces tab content container
3. Ensure TraceVisualization receives proper height constraints
4. Pass `runId` prop to TraceVisualization for Info view display
5. Synchronize view mode between embedded and fullscreen views

**Key State:**
```typescript
const [traceViewMode, setTraceViewMode] = useState<ViewMode>('info'); // Changed from 'timeline'
const [traceFullscreenOpen, setTraceFullscreenOpen] = useState(false);
const [selectedSpan, setSelectedSpan] = useState<Span | null>(null);
```

**Layout Structure:**
```tsx
<TabsContent value="logs" className="p-6 mt-0 flex-1 flex flex-col min-h-0">
  <div className="space-y-4 flex-1 flex flex-col min-h-0">
    {/* Header with ViewToggle */}
    <div className="flex items-center justify-between flex-shrink-0">
      <h3>Traces</h3>
      <ViewToggle viewMode={traceViewMode} onChange={setTraceViewMode} />
    </div>
    
    {/* Trace visualization in flex container */}
    <Card className="flex-1 flex flex-col min-h-0">
      <CardContent className="p-0 flex-1 flex flex-col min-h-0">
        <div className="flex-1 min-h-0">
          <TraceVisualization
            spanTree={spanTree}
            timeRange={timeRange}
            initialViewMode={traceViewMode}
            onViewModeChange={setTraceViewMode}
            showViewToggle={false}
            showSpanDetailsPanel={true}
            selectedSpan={selectedSpan}
            onSelectSpan={setSelectedSpan}
            expandedSpans={expandedSpans}
            onToggleExpand={handleToggleExpand}
            runId={report.runId}
          />
        </div>
      </CardContent>
    </Card>
  </div>
</TabsContent>
```

#### TraceVisualization.tsx

**Changes:**
1. Update `initialViewMode` default prop from `'timeline'` to `'info'`
2. Ensure all view modes properly handle height constraints
3. Add proper overflow handling for each view mode
4. Pass `runId` prop to TraceInfoView

**Props Interface:**
```typescript
interface TraceVisualizationProps {
  spanTree: Span[];
  timeRange: TimeRange;
  initialViewMode?: ViewMode; // Default: 'info'
  onViewModeChange?: (mode: ViewMode) => void;
  showViewToggle?: boolean;
  height?: string;
  showSpanDetailsPanel?: boolean;
  selectedSpan?: Span | null;
  onSelectSpan?: (span: Span | null) => void;
  expandedSpans?: Set<string>;
  onToggleExpand?: (spanId: string) => void;
  runId?: string; // NEW: For Info view display
}
```

**View Mode Rendering:**
```typescript
// Info view - full height with overflow
{viewMode === 'info' ? (
  <div className="h-full w-full overflow-auto">
    <TraceInfoView spanTree={spanTree} runId={runId} />
  </div>
) : /* other views */}
```

#### ViewToggle.tsx

**Changes:**
1. Update button order to: Info, Trace Tree, Agent Map, Timeline
2. Ensure Info is the first option for better discoverability

**Button Order:**
```typescript
const viewOptions = [
  { value: 'info', label: 'Info', icon: Info },
  { value: 'timeline', label: 'Trace Tree', icon: List },
  { value: 'agent-map', label: 'Agent Map', icon: GitBranch },
  { value: 'gantt', label: 'Timeline', icon: BarChart3 },
];
```

#### TraceFullScreenView.tsx

**Changes:**
1. Accept `initialViewMode` prop to sync with embedded view
2. Accept `onViewModeChange` callback to sync back to parent
3. Ensure view mode changes in fullscreen update the parent state

**Props Interface:**
```typescript
interface TraceFullScreenViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  spanTree: Span[];
  timeRange: TimeRange;
  selectedSpan: Span | null;
  onSelectSpan: (span: Span | null) => void;
  initialViewMode?: ViewMode; // NEW: Sync with parent
  onViewModeChange?: (mode: ViewMode) => void; // NEW: Sync back to parent
  spanCount?: number;
}
```

### Unchanged Components

The following components work correctly and don't require modifications:

- **TraceInfoView.tsx**: Already displays trace overview with proper styling
- **TraceTreeTable.tsx**: Handles tree view rendering
- **TraceTimelineChart.tsx**: Handles gantt chart rendering
- **AgentMapView.tsx**: Handles agent map visualization
- **TraceStatsView.tsx**: Handles statistics display
- **SpanDetailsPanel.tsx**: Handles span detail display

## Data Models

### ViewMode Type

```typescript
type ViewMode = 'info' | 'timeline' | 'gantt' | 'flow' | 'agent-map' | 'stats';
```

**Default:** `'info'`

**View Mode Descriptions:**
- `info`: Overview with metrics, time distribution, and span categories
- `timeline`: Tree table view with expandable spans
- `gantt`: Timeline chart with horizontal bars
- `agent-map`: Visual map of agent execution flow
- `stats`: Summary statistics and metrics

### Span Interface

```typescript
interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  endTime: string;
  duration: number;
  status: 'OK' | 'ERROR' | 'UNSET';
  attributes?: Record<string, unknown>;
  children?: Span[];
  category?: 'agent' | 'llm' | 'tool' | 'other';
}
```

### TimeRange Interface

```typescript
interface TimeRange {
  startTime: number;
  endTime: number;
  duration: number;
}
```

## Correctness Properties


A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

### Property 1: Layout Height Constraint

*For any* trace data loaded in the Traces tab, the TraceVisualization component should fill the available container height without causing overflow at the tab level.

**Validates: Requirements 1.2, 2.2**

### Property 2: Responsive Layout Stability

*For any* viewport width, the trace visualization layout should remain intact without breaking, and all UI elements should remain accessible.

**Validates: Requirements 1.3, 8.1**

### Property 3: Tab Switch State Preservation

*For any* view mode and selected span, switching away from the Traces tab and back should preserve the view mode and selected span state.

**Validates: Requirements 1.4**

### Property 4: View Mode Height Consistency

*For any* pair of view modes, switching between them should maintain the same container height allocation.

**Validates: Requirements 2.3**

### Property 5: Details Panel Collapse Stability

*For any* trace visualization state, collapsing or expanding the details panel should not change the overall container height.

**Validates: Requirements 2.4**

### Property 6: Span Selection Panel Display

*For any* span in the trace tree, selecting it should display the details panel on the right side with the span's information.

**Validates: Requirements 3.1**

### Property 7: Resizable Divider Width Update

*For any* drag position on the resizable divider, the width allocation between tree view and details panel should update proportionally while staying within the 40-70% constraint range.

**Validates: Requirements 3.4, 8.3**

### Property 8: View Mode Padding Consistency

*For any* view mode, the padding and spacing values should remain consistent across all view modes.

**Validates: Requirements 4.6**

### Property 9: View Mode Component Rendering

*For any* view mode selection (info, timeline, gantt, agent-map, stats), the system should render the corresponding component (TraceInfoView, TraceTreeTable, TraceTimelineChart, AgentMapView, TraceStatsView).

**Validates: Requirements 4.2, 4.3, 4.4, 4.5**

### Property 10: Embedded-Fullscreen State Synchronization

*For any* view mode and selected span, opening fullscreen should preserve the state, and changes made in fullscreen should be reflected in the embedded view when closed.

**Validates: Requirements 5.2, 5.3, 9.1, 9.2, 9.4**

### Property 11: Expansion State Persistence

*For any* set of expanded spans, changing the view mode should maintain the expansion state when returning to a view mode that uses expansion (timeline, gantt).

**Validates: Requirements 9.3**

### Property 12: Independent Panel Scrolling

*For any* scroll position in the tree view, scrolling should not affect the details panel scroll position, and vice versa.

**Validates: Requirements 10.3, 10.4**

## Error Handling

### Layout Errors

**Scenario:** TraceVisualization component fails to render due to invalid span data

**Handling:**
- Display error boundary with message: "Failed to render trace visualization"
- Log error details to console for debugging
- Provide fallback UI with option to reload traces

**Implementation:**
```typescript
// In RunDetailsContent.tsx
{tracesError && !tracesLoading && (
  <Card className="bg-red-500/10 border-red-500/30">
    <CardContent className="p-4 flex items-center gap-3">
      <AlertCircle className="text-red-400" size={18} />
      <div>
        <div className="text-sm font-medium text-red-400">Failed to load traces</div>
        <div className="text-xs text-muted-foreground">{tracesError}</div>
      </div>
    </CardContent>
  </Card>
)}
```

### State Synchronization Errors

**Scenario:** View mode or selected span fails to sync between embedded and fullscreen views

**Handling:**
- Log warning to console
- Fall back to default state (info view, no selected span)
- Continue operation without blocking user

**Implementation:**
```typescript
// In TraceFullScreenView.tsx
useEffect(() => {
  try {
    if (initialViewMode) {
      setViewMode(initialViewMode);
    }
  } catch (error) {
    console.warn('Failed to sync view mode:', error);
    setViewMode('info'); // Fallback to default
  }
}, [initialViewMode]);
```

### Resize Errors

**Scenario:** Resizable divider drag produces invalid width values

**Handling:**
- Constrain width values to valid range (40-70%)
- Prevent invalid state from being applied
- Log warning if constraint is triggered

**Implementation:**
```typescript
// In TraceVisualization.tsx
const handleMouseMove = (e: MouseEvent) => {
  if (!isResizing) return;
  
  const container = document.querySelector('.timeline-container');
  if (!container) return;
  
  const rect = container.getBoundingClientRect();
  const newWidth = ((e.clientX - rect.left) / rect.width) * 100;
  
  // Constrain between 40% and 70%
  const constrainedWidth = Math.max(40, Math.min(70, newWidth));
  
  if (newWidth !== constrainedWidth) {
    console.warn('Resize constrained to valid range:', constrainedWidth);
  }
  
  setTimelineWidth(constrainedWidth);
};
```

## Testing Strategy

### Unit Tests

Unit tests will focus on specific examples, edge cases, and component integration:

1. **Default State Tests**
   - Verify initial view mode is 'info'
   - Verify ViewToggle button order is correct
   - Verify default layout classes are applied

2. **View Mode Rendering Tests**
   - Test each view mode renders the correct component
   - Test view mode toggle updates state correctly
   - Test view mode persists across tab switches

3. **Layout Tests**
   - Test flex classes are applied to containers
   - Test Card wrapper has correct flex classes
   - Test TraceVisualization receives height constraints

4. **State Synchronization Tests**
   - Test selected span syncs to fullscreen
   - Test view mode syncs to fullscreen
   - Test fullscreen changes sync back to embedded view

5. **Error State Tests**
   - Test loading indicator displays during fetch
   - Test error message displays on fetch failure
   - Test pending state displays when appropriate
   - Test no-runId state displays correct message

6. **Edge Cases**
   - Test empty span tree displays "No spans" message
   - Test single span displays correctly
   - Test deeply nested spans render without overflow
   - Test very long span names truncate properly

### Property-Based Tests

Property-based tests will verify universal properties across randomized inputs. Each test should run a minimum of 100 iterations.

#### Property Test 1: Layout Height Constraint

**Test:** Generate random trace data with varying span counts (1-100 spans) and verify the TraceVisualization component fills the container height without overflow.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 1: For any trace data loaded in the Traces tab, the TraceVisualization component should fill the available container height without causing overflow at the tab level`

**Implementation:**
```typescript
// Generate random span tree
const spanTree = generateRandomSpans(randomInt(1, 100));

// Render component
render(<TraceVisualization spanTree={spanTree} ... />);

// Verify no overflow at tab level
const tabContent = screen.getByTestId('traces-tab-content');
expect(tabContent.scrollHeight).toBeLessThanOrEqual(tabContent.clientHeight);

// Verify visualization fills available height
const visualization = screen.getByTestId('trace-visualization');
expect(visualization.clientHeight).toBeGreaterThan(0);
```

#### Property Test 2: Responsive Layout Stability

**Test:** Generate random viewport widths (320px - 2560px) and verify the layout remains intact without breaking.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 2: For any viewport width, the trace visualization layout should remain intact without breaking`

**Implementation:**
```typescript
// Generate random viewport width
const viewportWidth = randomInt(320, 2560);
window.innerWidth = viewportWidth;

// Render component
render(<TraceVisualization spanTree={spanTree} ... />);

// Verify no horizontal overflow
const container = screen.getByTestId('trace-container');
expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);

// Verify both panels visible when details panel is open
if (detailsPanelOpen) {
  expect(screen.getByTestId('tree-view')).toBeVisible();
  expect(screen.getByTestId('details-panel')).toBeVisible();
}
```

#### Property Test 3: Tab Switch State Preservation

**Test:** Generate random view modes and selected spans, switch tabs, and verify state is preserved.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 3: For any view mode and selected span, switching away from the Traces tab and back should preserve the state`

**Implementation:**
```typescript
// Generate random view mode and span
const viewMode = randomChoice(['info', 'timeline', 'gantt', 'agent-map', 'stats']);
const selectedSpan = randomChoice(spanTree);

// Set state
setViewMode(viewMode);
setSelectedSpan(selectedSpan);

// Switch to another tab
fireEvent.click(screen.getByText('Summary'));

// Switch back to Traces tab
fireEvent.click(screen.getByText('Traces'));

// Verify state preserved
expect(getCurrentViewMode()).toBe(viewMode);
expect(getSelectedSpan()).toBe(selectedSpan);
```

#### Property Test 4: View Mode Height Consistency

**Test:** Generate random pairs of view modes and verify container height remains consistent when switching.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 4: For any pair of view modes, switching between them should maintain the same container height`

**Implementation:**
```typescript
// Generate random view mode pair
const viewMode1 = randomChoice(['info', 'timeline', 'gantt', 'agent-map', 'stats']);
const viewMode2 = randomChoice(['info', 'timeline', 'gantt', 'agent-map', 'stats']);

// Measure height in first view mode
setViewMode(viewMode1);
const height1 = screen.getByTestId('trace-container').clientHeight;

// Switch to second view mode
setViewMode(viewMode2);
const height2 = screen.getByTestId('trace-container').clientHeight;

// Verify heights are equal
expect(height1).toBe(height2);
```

#### Property Test 5: Details Panel Collapse Stability

**Test:** Generate random trace states and verify collapsing/expanding details panel doesn't change container height.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 5: For any trace visualization state, collapsing or expanding the details panel should not change the overall container height`

**Implementation:**
```typescript
// Generate random trace state
const spanTree = generateRandomSpans(randomInt(1, 100));
const selectedSpan = randomChoice(spanTree);

// Measure height with panel expanded
setSelectedSpan(selectedSpan);
const heightExpanded = screen.getByTestId('trace-container').clientHeight;

// Collapse panel
fireEvent.click(screen.getByTestId('collapse-button'));
const heightCollapsed = screen.getByTestId('trace-container').clientHeight;

// Expand panel
fireEvent.click(screen.getByTestId('expand-button'));
const heightReExpanded = screen.getByTestId('trace-container').clientHeight;

// Verify heights are equal
expect(heightExpanded).toBe(heightCollapsed);
expect(heightCollapsed).toBe(heightReExpanded);
```

#### Property Test 6: Span Selection Panel Display

**Test:** Generate random spans and verify selecting any span displays the details panel with correct information.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 6: For any span in the trace tree, selecting it should display the details panel with the span's information`

**Implementation:**
```typescript
// Generate random span tree
const spanTree = generateRandomSpans(randomInt(1, 100));
const randomSpan = randomChoice(flattenSpans(spanTree));

// Select span
fireEvent.click(screen.getByTestId(`span-${randomSpan.spanId}`));

// Verify details panel displays
expect(screen.getByTestId('details-panel')).toBeVisible();

// Verify panel shows correct span info
expect(screen.getByText(randomSpan.name)).toBeInTheDocument();
expect(screen.getByText(randomSpan.spanId)).toBeInTheDocument();
```

#### Property Test 7: Resizable Divider Width Update

**Test:** Generate random drag positions and verify width allocation updates correctly within constraints.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 7: For any drag position on the resizable divider, the width allocation should update proportionally while staying within the 40-70% constraint range`

**Implementation:**
```typescript
// Generate random drag position (as percentage of container width)
const dragPercent = randomInt(0, 100);

// Simulate drag
const divider = screen.getByTestId('resizable-divider');
const container = screen.getByTestId('timeline-container');
const containerRect = container.getBoundingClientRect();
const dragX = containerRect.left + (containerRect.width * dragPercent / 100);

fireEvent.mouseDown(divider);
fireEvent.mouseMove(document, { clientX: dragX });
fireEvent.mouseUp(document);

// Get resulting widths
const treeWidth = getComputedWidth(screen.getByTestId('tree-view'));
const detailsWidth = getComputedWidth(screen.getByTestId('details-panel'));

// Verify widths sum to 100%
expect(treeWidth + detailsWidth).toBeCloseTo(100, 1);

// Verify widths are within constraints
expect(treeWidth).toBeGreaterThanOrEqual(40);
expect(treeWidth).toBeLessThanOrEqual(70);
```

#### Property Test 8: View Mode Padding Consistency

**Test:** Generate random view modes and verify padding values remain consistent.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 8: For any view mode, the padding and spacing values should remain consistent`

**Implementation:**
```typescript
// Collect padding values for all view modes
const viewModes = ['info', 'timeline', 'gantt', 'agent-map', 'stats'];
const paddingValues = viewModes.map(mode => {
  setViewMode(mode);
  const container = screen.getByTestId('view-content');
  return getComputedStyle(container).padding;
});

// Verify all padding values are equal
const firstPadding = paddingValues[0];
paddingValues.forEach(padding => {
  expect(padding).toBe(firstPadding);
});
```

#### Property Test 9: View Mode Component Rendering

**Test:** Generate random view modes and verify the correct component is rendered for each.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 9: For any view mode selection, the system should render the corresponding component`

**Implementation:**
```typescript
// Test each view mode
const viewModeComponentMap = {
  'info': 'TraceInfoView',
  'timeline': 'TraceTreeTable',
  'gantt': 'TraceTimelineChart',
  'agent-map': 'AgentMapView',
  'stats': 'TraceStatsView',
};

Object.entries(viewModeComponentMap).forEach(([mode, componentName]) => {
  setViewMode(mode as ViewMode);
  expect(screen.getByTestId(componentName)).toBeInTheDocument();
});
```

#### Property Test 10: Embedded-Fullscreen State Synchronization

**Test:** Generate random view modes and selected spans, verify state syncs bidirectionally between embedded and fullscreen views.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 10: For any view mode and selected span, opening fullscreen should preserve the state, and changes made in fullscreen should be reflected in the embedded view`

**Implementation:**
```typescript
// Generate random initial state
const initialViewMode = randomChoice(['info', 'timeline', 'gantt', 'agent-map', 'stats']);
const initialSpan = randomChoice(spanTree);

// Set initial state in embedded view
setViewMode(initialViewMode);
setSelectedSpan(initialSpan);

// Open fullscreen
fireEvent.click(screen.getByTestId('fullscreen-button'));

// Verify state preserved in fullscreen
expect(getFullscreenViewMode()).toBe(initialViewMode);
expect(getFullscreenSelectedSpan()).toBe(initialSpan);

// Change state in fullscreen
const newViewMode = randomChoice(['info', 'timeline', 'gantt', 'agent-map', 'stats']);
const newSpan = randomChoice(spanTree);
setFullscreenViewMode(newViewMode);
setFullscreenSelectedSpan(newSpan);

// Close fullscreen
fireEvent.click(screen.getByTestId('close-fullscreen'));

// Verify embedded view reflects changes
expect(getViewMode()).toBe(newViewMode);
expect(getSelectedSpan()).toBe(newSpan);
```

#### Property Test 11: Expansion State Persistence

**Test:** Generate random expansion states and verify they persist across view mode changes.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 11: For any set of expanded spans, changing the view mode should maintain the expansion state`

**Implementation:**
```typescript
// Generate random expansion state
const spanTree = generateRandomSpans(randomInt(5, 50));
const expandedSpanIds = randomSubset(spanTree.map(s => s.spanId), randomInt(1, 10));
expandedSpanIds.forEach(id => {
  fireEvent.click(screen.getByTestId(`expand-${id}`));
});

// Get initial expansion state
const initialExpanded = getExpandedSpans();

// Switch view modes
setViewMode('gantt');
setViewMode('timeline');

// Verify expansion state preserved
const finalExpanded = getExpandedSpans();
expect(finalExpanded).toEqual(initialExpanded);
```

#### Property Test 12: Independent Panel Scrolling

**Test:** Generate random scroll positions and verify scrolling one panel doesn't affect the other.

**Tag:** `Feature: benchmark-traces-tab-fix, Property 12: For any scroll position in the tree view, scrolling should not affect the details panel scroll position`

**Implementation:**
```typescript
// Generate large trace data to enable scrolling
const spanTree = generateRandomSpans(100);
const selectedSpan = spanTree[0];
setSelectedSpan(selectedSpan);

// Scroll tree view to random position
const treeView = screen.getByTestId('tree-view');
const randomTreeScroll = randomInt(0, treeView.scrollHeight - treeView.clientHeight);
treeView.scrollTop = randomTreeScroll;

// Get details panel scroll position
const detailsPanel = screen.getByTestId('details-panel');
const initialDetailsScroll = detailsPanel.scrollTop;

// Verify details panel scroll didn't change
expect(detailsPanel.scrollTop).toBe(initialDetailsScroll);

// Now scroll details panel
const randomDetailsScroll = randomInt(0, detailsPanel.scrollHeight - detailsPanel.clientHeight);
detailsPanel.scrollTop = randomDetailsScroll;

// Verify tree view scroll didn't change
expect(treeView.scrollTop).toBe(randomTreeScroll);
```

### Integration Tests

Integration tests will verify the complete flow of user interactions:

1. **Complete Trace Viewing Flow**
   - Load benchmark page with trace data
   - Verify Traces tab displays info view by default
   - Switch between all view modes
   - Select spans and verify details panel
   - Open fullscreen and verify state sync
   - Close fullscreen and verify state restored

2. **Responsive Behavior Flow**
   - Resize browser window to various sizes
   - Verify layout adapts correctly
   - Verify panels remain accessible
   - Verify text remains readable

3. **Error Recovery Flow**
   - Trigger trace fetch failure
   - Verify error message displays
   - Retry fetch
   - Verify successful load

### Test Configuration

All property-based tests must:
- Run a minimum of 100 iterations per test
- Use a seeded random generator for reproducibility
- Tag each test with the feature name and property text
- Report failing examples with full context for debugging

Example test configuration:
```typescript
describe('Property Tests: Benchmark Traces Tab', () => {
  const ITERATIONS = 100;
  const SEED = 12345;
  
  beforeEach(() => {
    seedRandom(SEED);
  });
  
  test('Property 1: Layout Height Constraint', () => {
    for (let i = 0; i < ITERATIONS; i++) {
      // Test implementation
    }
  });
});
```
