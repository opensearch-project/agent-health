# Agent Trace Flyout Behavior - Design Document

## 1. Design Overview

### 1.1 Architecture Summary
This feature enhances the trace flyout interaction through three coordinated improvements:

1. **Context-based Sidebar Control**: Expose sidebar collapse state through React Context
2. **Smart Flyout State Management**: Track flyout open state to prevent unnecessary close/reopen cycles
3. **Custom Click-Outside Detection**: Implement intelligent click detection to distinguish between table and external clicks

### 1.2 Design Principles
- **Minimal State Changes**: Only update state when necessary to avoid re-renders
- **Separation of Concerns**: Layout manages sidebar, AgentTracesPage manages flyout
- **Progressive Enhancement**: Build on existing functionality without breaking changes
- **User-Centric**: Optimize for common workflows (viewing multiple traces)

## 2. Component Architecture

### 2.1 Component Hierarchy
```
Layout (Context Provider)
├── SidebarCollapseContext
├── Sidebar
└── SidebarInset
    └── AgentTracesPage (Context Consumer)
        ├── Traces Table
        └── Sheet (Flyout)
            └── TraceFlyoutContent
```

### 2.2 Data Flow
```
User clicks row
    ↓
AgentTracesPage.handleSelectTrace()
    ↓
Check: Is flyout already open?
    ├── Yes: Update selectedTrace only
    └── No: Update selectedTrace + Open flyout + Collapse sidebar
        ↓
    setIsCollapsed(true) via Context
        ↓
    Layout updates sidebar state
```

## 3. Detailed Design

### 3.1 Sidebar Collapse Context (Layout.tsx)

#### 3.1.1 Context Definition
```typescript
interface SidebarCollapseContextType {
  isCollapsed: boolean;
  setIsCollapsed: (collapsed: boolean) => void;
}

const SidebarCollapseContext = createContext<SidebarCollapseContextType | null>(null);
```

**Design Rationale:**
- Simple interface with only collapse state and setter
- Null default to enforce proper usage within provider
- Type-safe with TypeScript interface

#### 3.1.2 Hook Implementation
```typescript
export const useSidebarCollapse = () => {
  const context = useContext(SidebarCollapseContext);
  if (!context) {
    throw new Error('useSidebarCollapse must be used within Layout');
  }
  return context;
};
```

**Design Rationale:**
- Throws error if used outside provider (fail-fast)
- Provides clean API for consumers
- Follows React Context best practices

#### 3.1.3 Provider Integration
```typescript
<SidebarCollapseContext.Provider value={{ isCollapsed, setIsCollapsed }}>
  <SidebarProvider>
    {/* Sidebar and content */}
  </SidebarProvider>
</SidebarCollapseContext.Provider>
```

**Design Rationale:**
- Wraps existing SidebarProvider to avoid breaking changes
- Exposes existing state management to children
- No additional state introduced

### 3.2 Flyout Width Configuration (AgentTracesPage.tsx)

#### 3.2.1 Default Width Calculation
```typescript
const [flyoutWidth, setFlyoutWidth] = useState(() => {
  if (typeof window !== 'undefined') {
    return Math.floor(window.innerWidth * 0.60);
  }
  return 1200; // fallback for SSR
});
```

**Design Rationale:**
- 60% provides balanced view of table and flyout
- Lazy initialization prevents SSR issues
- Fallback ensures consistent behavior
- Math.floor ensures integer pixel values

**Width Comparison:**
- Before: 65% (1300px fallback) - too wide, cramped table
- After: 60% (1200px fallback) - balanced layout

### 3.3 Smart Row Selection (AgentTracesPage.tsx)

#### 3.3.1 Selection Handler
```typescript
const handleSelectTrace = (trace: TraceTableRow) => {
  setSelectedTrace(trace);
  if (!flyoutOpen) {
    setFlyoutOpen(true);
    setIsCollapsed(true);
  }
};
```

**Design Rationale:**
- Always update selected trace (required for both cases)
- Conditional logic prevents unnecessary state updates
- Sidebar collapse only on initial open (not on switches)
- Simple boolean check for flyout state

**State Transition Table:**
| Current State | Action | New State | Side Effects |
|--------------|--------|-----------|--------------|
| Flyout closed | Click row | Flyout open | Open flyout, collapse sidebar, set trace |
| Flyout open | Click same row | Flyout open | No change |
| Flyout open | Click different row | Flyout open | Update trace only |

#### 3.3.2 Why This Prevents Flash
**Before:**
```typescript
const handleSelectTrace = (trace: TraceTableRow) => {
  setSelectedTrace(trace);
  setFlyoutOpen(true); // Always sets to true, even if already true
};
```
- Setting `flyoutOpen` to `true` when already `true` triggers Sheet re-mount
- Sheet component interprets this as close → open transition
- Results in visible animation flash

**After:**
```typescript
if (!flyoutOpen) {
  setFlyoutOpen(true); // Only set when actually closed
}
```
- Only updates state when necessary
- Sheet remains mounted when switching traces
- No re-mount, no animation flash

### 3.4 Click-Outside Detection (AgentTracesPage.tsx)

#### 3.4.1 Handler Implementation
```typescript
const handleInteractOutside = useCallback((event: Event) => {
  const target = event.target as HTMLElement;
  
  const isInsideTable = target.closest('table') !== null || 
                        target.closest('[data-table-container]') !== null;
  
  if (isInsideTable) {
    event.preventDefault();
    return;
  }
}, []);
```

**Design Rationale:**
- Uses `closest()` for efficient DOM traversal
- Checks both table element and container for reliability
- Prevents default behavior only when needed
- Memoized with useCallback to prevent re-creation

#### 3.4.2 DOM Structure
```typescript
<Card data-table-container>
  <table>
    <tbody>
      <tr onClick={handleSelectTrace}>
        {/* Row content */}
      </tr>
    </tbody>
  </table>
</Card>
```

**Design Rationale:**
- `data-table-container` attribute marks the interactive area
- Allows clicks anywhere in Card to be considered "inside table"
- Handles edge cases (padding, margins, scrollbars)

#### 3.4.3 Integration with Sheet
```typescript
<SheetContent 
  onInteractOutside={handleInteractOutside}
>
```

**Design Rationale:**
- Uses Radix UI's built-in event handler
- Leverages existing Dialog primitive behavior
- No need for custom event listeners

### 3.5 Click Detection Logic Flow

```
User clicks somewhere
    ↓
Radix UI Dialog detects click outside flyout
    ↓
Calls onInteractOutside(event)
    ↓
handleInteractOutside checks:
    ├── Is click inside <table>? → Yes → preventDefault() → Flyout stays open
    ├── Is click inside [data-table-container]? → Yes → preventDefault() → Flyout stays open
    └── Neither? → Allow default → Flyout closes
```

## 4. State Management

### 4.1 State Variables

| Variable | Type | Scope | Purpose |
|----------|------|-------|---------|
| `isCollapsed` | boolean | Layout | Sidebar collapse state |
| `flyoutOpen` | boolean | AgentTracesPage | Flyout visibility |
| `selectedTrace` | TraceTableRow \| null | AgentTracesPage | Current trace data |
| `flyoutWidth` | number | AgentTracesPage | Flyout width in pixels |

### 4.2 State Update Patterns

#### 4.2.1 Opening Flyout (First Time)
```
User clicks row
    ↓
setSelectedTrace(trace)
setFlyoutOpen(true)
setIsCollapsed(true)
```

#### 4.2.2 Switching Traces
```
User clicks different row
    ↓
setSelectedTrace(newTrace)
(no other state changes)
```

#### 4.2.3 Closing Flyout
```
User clicks outside or presses Escape
    ↓
setFlyoutOpen(false)
setSelectedTrace(null)
(sidebar state unchanged)
```

## 5. Performance Considerations

### 5.1 Render Optimization

#### 5.1.1 Context Updates
- Context only provides collapse control, not frequent updates
- Only updates when sidebar is manually toggled or flyout opens
- No performance impact on table rendering

#### 5.1.2 Event Handler Memoization
```typescript
const handleInteractOutside = useCallback((event: Event) => {
  // Handler logic
}, []); // Empty deps - never recreates
```

**Benefit:** Prevents Sheet re-renders from handler recreation

#### 5.1.3 State Update Batching
React automatically batches state updates in event handlers:
```typescript
setSelectedTrace(trace);
setFlyoutOpen(true);
setIsCollapsed(true);
// All three updates batched into single render
```

### 5.2 DOM Query Performance
- `closest()` is optimized by browsers
- Queries are only performed on click events (infrequent)
- No continuous polling or observers needed

## 6. Edge Cases and Error Handling

### 6.1 Edge Cases

#### 6.1.1 Rapid Row Clicking
**Scenario:** User rapidly clicks multiple rows  
**Handling:** Each click updates selectedTrace, React batches updates  
**Result:** Smooth transition to final selected trace

#### 6.1.2 Clicking Table While Flyout Closed
**Scenario:** User clicks table when flyout is not open  
**Handling:** Normal row selection, opens flyout  
**Result:** Expected behavior, no issues

#### 6.1.3 Resizing Window
**Scenario:** User resizes browser window  
**Handling:** Flyout width remains in pixels, may need manual resize  
**Result:** Acceptable, user can resize flyout if needed

#### 6.1.4 SSR/Hydration
**Scenario:** Server-side rendering without window object  
**Handling:** Fallback width of 1200px used  
**Result:** Consistent initial render

### 6.2 Error Handling

#### 6.2.1 Context Usage Outside Provider
```typescript
if (!context) {
  throw new Error('useSidebarCollapse must be used within Layout');
}
```
**Rationale:** Fail-fast to catch integration errors during development

#### 6.2.2 Missing Table Container
If `data-table-container` is missing, `closest()` returns null:
```typescript
const isInsideTable = target.closest('table') !== null || 
                      target.closest('[data-table-container]') !== null;
```
**Fallback:** Still checks for `<table>` element directly

## 7. Testing Strategy

### 7.1 Unit Testing

#### 7.1.1 Context Hook
```typescript
describe('useSidebarCollapse', () => {
  it('throws error when used outside provider', () => {
    expect(() => {
      renderHook(() => useSidebarCollapse());
    }).toThrow('useSidebarCollapse must be used within Layout');
  });
  
  it('returns collapse control when used inside provider', () => {
    const wrapper = ({ children }) => (
      <Layout>{children}</Layout>
    );
    const { result } = renderHook(() => useSidebarCollapse(), { wrapper });
    expect(result.current).toHaveProperty('isCollapsed');
    expect(result.current).toHaveProperty('setIsCollapsed');
  });
});
```

#### 7.1.2 Click-Outside Handler
```typescript
describe('handleInteractOutside', () => {
  it('prevents close when clicking table', () => {
    const event = { target: tableElement, preventDefault: jest.fn() };
    handleInteractOutside(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
  
  it('allows close when clicking outside', () => {
    const event = { target: outsideElement, preventDefault: jest.fn() };
    handleInteractOutside(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
```

### 7.2 Integration Testing

#### 7.2.1 Flyout Opening
```typescript
it('opens flyout and collapses sidebar on first row click', () => {
  render(<AgentTracesPage />);
  const row = screen.getByText('trace-id-1');
  fireEvent.click(row);
  
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByTestId('sidebar')).toHaveClass('collapsed');
});
```

#### 7.2.2 Row Switching
```typescript
it('switches trace without closing flyout', () => {
  render(<AgentTracesPage />);
  
  // Open flyout
  fireEvent.click(screen.getByText('trace-id-1'));
  const flyout = screen.getByRole('dialog');
  
  // Switch to different trace
  fireEvent.click(screen.getByText('trace-id-2'));
  
  // Flyout should still be the same element (not re-mounted)
  expect(screen.getByRole('dialog')).toBe(flyout);
  expect(screen.getByText('trace-id-2')).toBeInTheDocument();
});
```

### 7.3 Manual Testing Checklist

- [ ] Open flyout - verify 60% width
- [ ] Open flyout - verify sidebar collapses
- [ ] Click different row - verify no flash
- [ ] Scroll table - verify flyout stays open
- [ ] Hover rows - verify hover effects work
- [ ] Click outside table and flyout - verify closes
- [ ] Click inside table - verify stays open
- [ ] Press Escape - verify closes
- [ ] Click close button - verify closes
- [ ] Resize flyout - verify still works

## 8. Accessibility Considerations

### 8.1 Keyboard Navigation
- Escape key continues to close flyout (preserved)
- Tab navigation works within flyout (preserved)
- Focus management handled by Radix UI (preserved)

### 8.2 Screen Readers
- Flyout announced as dialog (Radix UI default)
- Row selection announced (existing behavior)
- No changes to ARIA attributes needed

### 8.3 Focus Management
- Focus moves to flyout when opened (Radix UI default)
- Focus returns to trigger when closed (Radix UI default)
- No custom focus management needed

## 9. Browser Compatibility

### 9.1 DOM API Support
- `Element.closest()`: Supported in all modern browsers
- React Context API: Supported in React 16.3+
- No polyfills needed for target browsers

### 9.2 CSS Support
- Flexbox for layout (universal support)
- CSS transitions (universal support)
- No vendor prefixes needed

## 10. Migration and Rollout

### 10.1 Breaking Changes
**None** - This is a pure enhancement with no breaking changes

### 10.2 Backward Compatibility
- All existing functionality preserved
- Existing keyboard shortcuts work
- Existing resize functionality works
- Existing close behaviors work

### 10.3 Rollout Strategy
1. Deploy changes to development environment
2. Perform manual testing checklist
3. Deploy to staging for user acceptance testing
4. Deploy to production (no feature flag needed)

## 11. Future Enhancements

### 11.1 Keyboard Navigation
Add arrow key navigation between traces:
```typescript
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!flyoutOpen) return;
    
    if (e.key === 'ArrowDown') {
      // Select next trace
    } else if (e.key === 'ArrowUp') {
      // Select previous trace
    }
  };
  
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [flyoutOpen, selectedTrace]);
```

### 11.2 Persistent Width Preference
Remember user's preferred flyout width:
```typescript
const [flyoutWidth, setFlyoutWidth] = useState(() => {
  const saved = localStorage.getItem('flyoutWidth');
  return saved ? parseInt(saved) : defaultWidth;
});

useEffect(() => {
  localStorage.setItem('flyoutWidth', flyoutWidth.toString());
}, [flyoutWidth]);
```

### 11.3 Width Presets
Add quick width preset buttons:
```typescript
<div className="width-presets">
  <Button onClick={() => setFlyoutWidth(window.innerWidth * 0.5)}>50%</Button>
  <Button onClick={() => setFlyoutWidth(window.innerWidth * 0.6)}>60%</Button>
  <Button onClick={() => setFlyoutWidth(window.innerWidth * 0.75)}>75%</Button>
</div>
```

## 12. Correctness Properties

### 12.1 Property 1: Flyout Width Consistency
**Property:** When flyout opens, its width is always 60% of viewport width (or 1200px fallback)

**Validation:**
```typescript
// Property-based test
it('flyout width is always 60% of viewport', () => {
  fc.assert(
    fc.property(fc.integer(800, 3840), (viewportWidth) => {
      window.innerWidth = viewportWidth;
      const expectedWidth = Math.floor(viewportWidth * 0.60);
      
      render(<AgentTracesPage />);
      fireEvent.click(screen.getByText('trace-id-1'));
      
      const flyout = screen.getByRole('dialog');
      expect(flyout).toHaveStyle({ width: `${expectedWidth}px` });
    })
  );
});
```

### 12.2 Property 2: Sidebar Collapse on First Open
**Property:** Sidebar collapses if and only if flyout is opened from closed state

**Validation:**
```typescript
// Property-based test
it('sidebar collapses only on first flyout open', () => {
  fc.assert(
    fc.property(fc.array(fc.string()), (traceIds) => {
      fc.pre(traceIds.length > 1); // Need at least 2 traces
      
      render(<AgentTracesPage traces={traceIds} />);
      const sidebar = screen.getByTestId('sidebar');
      
      // First click - sidebar should collapse
      fireEvent.click(screen.getByText(traceIds[0]));
      expect(sidebar).toHaveClass('collapsed');
      
      // Subsequent clicks - sidebar should stay collapsed
      for (let i = 1; i < traceIds.length; i++) {
        fireEvent.click(screen.getByText(traceIds[i]));
        expect(sidebar).toHaveClass('collapsed');
      }
    })
  );
});
```

### 12.3 Property 3: No Flash on Row Switch
**Property:** When flyout is open, clicking a different row never causes flyout to unmount and remount

**Validation:**
```typescript
// Property-based test
it('flyout element identity preserved when switching rows', () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { minLength: 2 }), (traceIds) => {
      render(<AgentTracesPage traces={traceIds} />);
      
      // Open flyout
      fireEvent.click(screen.getByText(traceIds[0]));
      const initialFlyout = screen.getByRole('dialog');
      
      // Switch to each other trace
      for (let i = 1; i < traceIds.length; i++) {
        fireEvent.click(screen.getByText(traceIds[i]));
        const currentFlyout = screen.getByRole('dialog');
        
        // Same DOM element = no unmount/remount
        expect(currentFlyout).toBe(initialFlyout);
      }
    })
  );
});
```

### 12.4 Property 4: Click-Outside Behavior
**Property:** Flyout closes if and only if click is outside both table and flyout

**Validation:**
```typescript
// Property-based test
it('flyout closes only for clicks outside table and flyout', () => {
  fc.assert(
    fc.property(
      fc.record({
        clickTarget: fc.constantFrom('table', 'flyout', 'outside'),
      }),
      ({ clickTarget }) => {
        render(<AgentTracesPage />);
        
        // Open flyout
        fireEvent.click(screen.getByText('trace-id-1'));
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        
        // Click target
        const targets = {
          table: screen.getByRole('table'),
          flyout: screen.getByRole('dialog'),
          outside: document.body,
        };
        
        fireEvent.click(targets[clickTarget]);
        
        // Verify expected behavior
        if (clickTarget === 'outside') {
          expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        } else {
          expect(screen.getByRole('dialog')).toBeInTheDocument();
        }
      }
    )
  );
});
```

### 12.5 Property 5: State Consistency
**Property:** Selected trace in state always matches displayed trace in flyout

**Validation:**
```typescript
// Property-based test
it('selected trace state matches flyout content', () => {
  fc.assert(
    fc.property(fc.array(fc.string()), (traceIds) => {
      fc.pre(traceIds.length > 0);
      
      render(<AgentTracesPage traces={traceIds} />);
      
      for (const traceId of traceIds) {
        fireEvent.click(screen.getByText(traceId));
        
        const flyout = screen.getByRole('dialog');
        expect(flyout).toHaveTextContent(traceId);
      }
    })
  );
});
```

## 13. Implementation Notes

### 13.1 Code Organization
- Context definition in Layout.tsx (co-located with sidebar)
- Hook export from Layout.tsx (single source of truth)
- Consumer logic in AgentTracesPage.tsx (feature-specific)

### 13.2 Naming Conventions
- Context: `SidebarCollapseContext` (descriptive, specific)
- Hook: `useSidebarCollapse` (follows React conventions)
- Handler: `handleInteractOutside` (describes event)

### 13.3 Documentation
- Inline comments explain "why" not "what"
- JSDoc comments for public APIs
- README updated with new behavior description

## 14. References

### 14.1 Related Documentation
- [Radix UI Dialog](https://www.radix-ui.com/docs/primitives/components/dialog)
- [React Context API](https://react.dev/reference/react/useContext)
- [Element.closest() MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/closest)

### 14.2 Related Issues
- Original implementation: AGENT_TRACE_FLYOUT_BEHAVIOR.md
- Context transfer summary (this conversation)

### 14.3 Design Decisions Log
| Decision | Rationale | Alternatives Considered |
|----------|-----------|------------------------|
| Use Context for sidebar control | Avoids prop drilling, clean API | Props (too much drilling), Redux (overkill) |
| 60% default width | Balanced view of table and flyout | 50% (too narrow), 65% (too wide) |
| Check flyout state before opening | Prevents unnecessary re-renders | Always set state (causes flash) |
| Use closest() for click detection | Efficient, reliable | Manual DOM traversal (complex), event bubbling (unreliable) |
