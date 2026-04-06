# Agent Trace Flyout Behavior Implementation

## Summary
Implemented refined trace flyout behavior with intelligent click-outside handling:

1. **60% Screen Width**: Flyout opens at 60% of viewport width (changed from 65%)
2. **Auto-collapse Sidebar**: Sidebar automatically collapses when flyout opens to provide more screen space
3. **Smooth Row Switching**: Clicking another row while flyout is open updates content without closing/reopening (no flash)
4. **Smart Click-Outside**: Flyout only closes when clicking outside both the table AND the flyout
5. **Table Remains Interactive**: Users can scroll and interact with the table while flyout is open

## Changes Made

### 1. Layout.tsx
- Created `SidebarCollapseContext` to expose sidebar collapse control
- Added `useSidebarCollapse()` hook for child components to access collapse functionality
- Wrapped SidebarProvider with the new context provider

```typescript
// New context for sidebar collapse control
interface SidebarCollapseContextType {
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
}

const SidebarCollapseContext = createContext<SidebarCollapseContextType | null>(null);

export const useSidebarCollapse = () => {
  const context = useContext(SidebarCollapseContext);
  if (!context) {
    throw new Error('useSidebarCollapse must be used within Layout');
  }
  return context;
};
```

### 2. AgentTracesPage.tsx

#### Changed Default Flyout Width
```typescript
// Before: 65% of viewport width
const [flyoutWidth, setFlyoutWidth] = useState(() => {
  if (typeof window !== 'undefined') {
    return Math.floor(window.innerWidth * 0.65);
  }
  return 1300;
});

// After: 60% of viewport width
const [flyoutWidth, setFlyoutWidth] = useState(() => {
  if (typeof window !== 'undefined') {
    return Math.floor(window.innerWidth * 0.60);
  }
  return 1200;
});
```

#### Updated handleSelectTrace Function
```typescript
// Before: Always opened flyout, causing flash when switching rows
const handleSelectTrace = (trace: TraceTableRow) => {
  setSelectedTrace(trace);
  setFlyoutOpen(true);
};

// After: Smart behavior - no flash when switching rows, auto-collapse sidebar
const handleSelectTrace = (trace: TraceTableRow) => {
  // If flyout is already open, just update the selected trace (no close/reopen flash)
  // If flyout is closed, open it with the selected trace and collapse the sidebar
  setSelectedTrace(trace);
  if (!flyoutOpen) {
    setFlyoutOpen(true);
    // Collapse sidebar when opening flyout for more screen space
    setIsCollapsed(true);
  }
};
```

#### Added Smart Click-Outside Handler
```typescript
// Handle click outside - only close if clicking outside both table and flyout
const handleInteractOutside = (event: Event) => {
  const target = event.target as HTMLElement;
  
  // Check if click is inside the table or flyout
  const isInsideTable = target.closest('table') !== null;
  const isInsideFlyout = target.closest('[data-flyout-content]') !== null;
  const isResizeHandle = target.closest('[data-resize-handle]') !== null;
  
  // Only close if clicking outside both table and flyout
  if (!isInsideTable && !isInsideFlyout && !isResizeHandle) {
    handleCloseFlyout();
  } else {
    // Prevent default close behavior
    event.preventDefault();
  }
};
```

#### Added Data Attributes for Element Identification
```typescript
<SheetContent 
  onInteractOutside={handleInteractOutside}
  data-flyout-content
>
  <div data-resize-handle>
    {/* Resize handle */}
  </div>
</SheetContent>
```

### 3. Sheet Component (ui/sheet.tsx)
- Already has `pointerEvents: 'none'` on overlay, allowing interaction with underlying content
- Uses Radix UI Dialog primitive which supports `onInteractOutside` event
- No modifications needed - leveraged existing features

## User Experience Improvements

### Before
- Flyout opened at 65% width
- Sidebar remained open, reducing available space
- Clicking another row caused flyout to close and reopen (visible flash)
- Clicking anywhere outside flyout closed it (including table area)
- Table was not interactive while flyout was open

### After
- Flyout opens at 60% width (more balanced layout)
- Sidebar automatically collapses when flyout opens (more screen space)
- Clicking another row smoothly updates content without closing/reopening
- Flyout only closes when clicking outside BOTH table and flyout
- Table remains fully interactive - users can scroll, hover, and click rows
- Table and flyout work as a coupled unit

## Interaction Patterns

### Row Switching
1. User clicks Row A → Flyout opens with Row A content
2. User clicks Row B → Flyout content smoothly updates to Row B (no close/reopen)
3. User clicks Row C → Flyout content smoothly updates to Row C
4. No flash or animation between row switches

### Click Outside to Close
1. Flyout is open
2. User clicks on table → Flyout stays open (table is interactive)
3. User scrolls table → Flyout stays open
4. User hovers over table rows → Flyout stays open
5. User clicks on page header/filters → Flyout closes
6. User clicks on sidebar → Flyout closes
7. User clicks on empty space → Flyout closes

### Table Interactivity
- Scrolling: Table can be scrolled while flyout is open
- Hovering: Row hover effects work normally
- Clicking: Rows can be clicked to switch flyout content
- Selecting: Row selection visual feedback works
- All table interactions preserved

## Technical Details

### Radix UI Dialog Features
The Sheet component is built on Radix UI's Dialog primitive, which provides:
- `onInteractOutside`: Event fired when user interacts outside the dialog
- `event.preventDefault()`: Prevents default close behavior
- Overlay with `pointerEvents: 'none'`: Allows clicks to pass through to underlying content

### Smart Click Detection
Uses DOM traversal to determine click context:
```typescript
const isInsideTable = target.closest('table') !== null;
const isInsideFlyout = target.closest('[data-flyout-content]') !== null;
const isResizeHandle = target.closest('[data-resize-handle]') !== null;
```

### Data Attributes
- `data-flyout-content`: Marks the flyout container
- `data-resize-handle`: Marks the resize handle
- Used for reliable element identification in click detection

### Context Pattern
Used React Context API to expose sidebar collapse control from Layout to child components:
- Avoids prop drilling through multiple component layers
- Provides clean API via `useSidebarCollapse()` hook
- Maintains separation of concerns

### State Management
- `flyoutOpen` state tracks whether flyout is currently open
- Only triggers sidebar collapse on initial flyout open (not on row switches)
- Preserves existing resize and close behaviors
- Click-outside handler prevents unwanted closes

### Performance
- No additional re-renders introduced
- Context only provides collapse control, not state changes
- Smooth transitions maintained with existing CSS
- Event handler uses efficient DOM queries

## Testing Recommendations

1. **Open Flyout**: Click any trace row
   - ✓ Verify flyout opens at 60% width
   - ✓ Verify sidebar collapses automatically

2. **Switch Rows**: With flyout open, click another row
   - ✓ Verify content updates smoothly
   - ✓ Verify no flash/close-reopen animation
   - ✓ Verify sidebar remains collapsed

3. **Table Interaction**: With flyout open
   - ✓ Scroll table up and down
   - ✓ Hover over different rows
   - ✓ Click different rows to switch content
   - ✓ Verify flyout stays open during all interactions

4. **Click Outside - Should Close**:
   - ✓ Click on page header
   - ✓ Click on filters/search bar
   - ✓ Click on sidebar
   - ✓ Click on empty space
   - ✓ Click on metrics overview

5. **Click Outside - Should NOT Close**:
   - ✓ Click on table rows
   - ✓ Click on table headers
   - ✓ Click on table scrollbar
   - ✓ Click on flyout content
   - ✓ Click on flyout resize handle

6. **Close Flyout**: Use close button
   - ✓ Verify flyout closes properly
   - ✓ Verify sidebar can be manually expanded again

7. **Resize**: Drag flyout resize handle
   - ✓ Verify resize still works correctly
   - ✓ Verify constraints (400px min, 90% max) still apply
   - ✓ Verify clicking resize handle doesn't close flyout

## Files Modified
- `agent-health-jasonlh/components/Layout.tsx`
- `agent-health-jasonlh/components/traces/AgentTracesPage.tsx`

## Files Analyzed (No Changes Needed)
- `agent-health-jasonlh/components/ui/sheet.tsx` - Already has required features
