# Implementation Plan: Benchmark Traces Tab Fix

## Overview

This implementation plan addresses layout and display issues in the Traces tab of the Benchmark page. The work focuses on applying proper flexbox layout, setting the correct default view mode, ensuring proper height constraints, and synchronizing state between embedded and fullscreen views.

## Tasks

- [x] 1. Update RunDetailsContent Traces tab layout and default view mode
  - Apply flexbox layout classes to Traces tab container (`flex-1 flex flex-col min-h-0`)
  - Change `traceViewMode` initial state from `'timeline'` to `'info'`
  - Wrap TraceVisualization in proper flex container with Card
  - Pass `runId` prop to TraceVisualization for Info view display
  - Ensure ViewToggle is positioned correctly in header
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 4.1_

- [ ]* 1.1 Write unit tests for Traces tab layout
  - Test flex classes are applied to tab container
  - Test Card wrapper has correct flex classes
  - Test default view mode is 'info'
  - Test runId is passed to TraceVisualization
  - _Requirements: 1.1, 2.1, 4.1_

- [ ]* 1.2 Write property test for layout height constraint
  - **Property 1: Layout Height Constraint**
  - **Validates: Requirements 1.2, 2.2**

- [x] 2. Update TraceVisualization default view mode and height handling
  - Change `initialViewMode` default prop from `'timeline'` to `'info'`
  - Add `runId` prop to interface and pass to TraceInfoView
  - Ensure all view modes use `h-full w-full` with appropriate overflow handling
  - Verify Info view uses `overflow-auto` for scrolling
  - Verify other views maintain proper height constraints
  - _Requirements: 2.2, 2.3, 4.1_

- [ ]* 2.1 Write unit tests for TraceVisualization view modes
  - Test default view mode is 'info'
  - Test runId is passed to TraceInfoView
  - Test each view mode renders correct component
  - Test view mode changes update state correctly
  - _Requirements: 2.3, 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ]* 2.2 Write property test for view mode height consistency
  - **Property 4: View Mode Height Consistency**
  - **Validates: Requirements 2.3**

- [ ]* 2.3 Write property test for view mode component rendering
  - **Property 9: View Mode Component Rendering**
  - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

- [x] 3. Update ViewToggle button order
  - Reorder view mode buttons to: Info, Trace Tree, Agent Map, Timeline
  - Update `viewOptions` array in ViewToggle component
  - Ensure icons and labels are correct for each button
  - _Requirements: 4.7_

- [ ]* 3.1 Write unit test for ViewToggle button order
  - Test buttons appear in correct order
  - Test Info button is first
  - Test all view modes are represented
  - _Requirements: 4.7_

- [x] 4. Update TraceFullScreenView to sync view mode with parent
  - Add `initialViewMode` prop to interface
  - Add `onViewModeChange` callback prop to interface
  - Pass `initialViewMode` to internal TraceVisualization
  - Call `onViewModeChange` when view mode changes in fullscreen
  - Ensure view mode syncs bidirectionally with parent
  - _Requirements: 5.2, 5.3, 9.1, 9.2, 9.4_

- [ ]* 4.1 Write unit tests for fullscreen state sync
  - Test initialViewMode is passed to TraceVisualization
  - Test onViewModeChange is called when view mode changes
  - Test selected span is preserved when opening fullscreen
  - Test view mode is preserved when opening fullscreen
  - _Requirements: 5.2, 5.3, 9.1, 9.2_

- [ ]* 4.2 Write property test for embedded-fullscreen state synchronization
  - **Property 10: Embedded-Fullscreen State Synchronization**
  - **Validates: Requirements 5.2, 5.3, 9.1, 9.2, 9.4**

- [x] 5. Wire fullscreen view mode sync in RunDetailsContent
  - Pass `initialViewMode={traceViewMode}` to TraceFullScreenView
  - Pass `onViewModeChange={setTraceViewMode}` to TraceFullScreenView
  - Verify view mode changes in fullscreen update embedded view
  - Verify view mode changes in embedded view update fullscreen
  - _Requirements: 5.2, 5.3, 9.2, 9.4_

- [ ]* 5.1 Write integration test for bidirectional view mode sync
  - Test changing view mode in embedded view updates fullscreen
  - Test changing view mode in fullscreen updates embedded view
  - Test state persists when switching between embedded and fullscreen
  - _Requirements: 5.2, 5.3, 9.2, 9.4_

- [x] 6. Verify and test responsive layout behavior
  - Test layout at various viewport widths (320px, 768px, 1024px, 1920px)
  - Verify details panel and tree view remain accessible on small screens
  - Verify resizable divider constraints (40-70%) work correctly
  - Verify no horizontal scrolling occurs at any viewport size
  - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [ ]* 6.1 Write property test for responsive layout stability
  - **Property 2: Responsive Layout Stability**
  - **Validates: Requirements 1.3, 8.1**

- [ ]* 6.2 Write property test for resizable divider width update
  - **Property 7: Resizable Divider Width Update**
  - **Validates: Requirements 3.4, 8.3**

- [ ]* 6.3 Write unit tests for responsive edge cases
  - Test minimum widths are enforced
  - Test both panels remain accessible on small screens
  - Test resizable divider constraints
  - _Requirements: 8.2, 8.3, 8.4_

- [x] 7. Verify state preservation across tab switches
  - Test view mode persists when switching tabs
  - Test selected span persists when switching tabs
  - Test expanded spans persist when switching tabs
  - Ensure state is maintained in RunDetailsContent component
  - _Requirements: 1.4, 9.3_

- [ ]* 7.1 Write property test for tab switch state preservation
  - **Property 3: Tab Switch State Preservation**
  - **Validates: Requirements 1.4**

- [ ]* 7.2 Write property test for expansion state persistence
  - **Property 11: Expansion State Persistence**
  - **Validates: Requirements 9.3**

- [x] 8. Verify details panel behavior
  - Test span selection displays details panel
  - Test details panel collapse/expand doesn't affect container height
  - Test details panel has independent scrolling
  - Test resizable divider updates width allocation
  - _Requirements: 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 10.1, 10.2, 10.3, 10.4_

- [ ]* 8.1 Write property test for span selection panel display
  - **Property 6: Span Selection Panel Display**
  - **Validates: Requirements 3.1**

- [ ]* 8.2 Write property test for details panel collapse stability
  - **Property 5: Details Panel Collapse Stability**
  - **Validates: Requirements 2.4**

- [ ]* 8.3 Write property test for independent panel scrolling
  - **Property 12: Independent Panel Scrolling**
  - **Validates: Requirements 10.3, 10.4**

- [ ]* 8.4 Write unit tests for details panel edge cases
  - Test panel displays on right side
  - Test width allocation is appropriate
  - Test panel collapses to full width tree view
  - Test panel remains scrollable with long content
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 10.2_

- [x] 9. Verify loading and error states
  - Test loading indicator displays during fetch
  - Test error message displays on fetch failure
  - Test pending state displays when appropriate
  - Test no-runId state displays correct message
  - Test successful load removes loading indicators
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ]* 9.1 Write unit tests for loading and error states
  - Test loading indicator appears during fetch
  - Test error message appears on failure
  - Test pending state message appears when status is pending
  - Test no-runId message appears when runId is missing
  - Test loading indicators removed on successful load
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 10. Verify trace tab activation behavior
  - Test auto-fetch on first tab click
  - Test state reset when switching reports
  - Test no re-fetch on subsequent tab activations
  - Test no fetch when report status is pending
  - Test manual "Load Traces" button appears when appropriate
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ]* 10.1 Write unit tests for trace tab activation
  - Test auto-fetch triggers on first click
  - Test state resets when report changes
  - Test fetch only happens once
  - Test no fetch when status is pending
  - Test manual load button appears in correct state
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

- [x] 11. Verify scroll behavior
  - Test tree view scrolls independently
  - Test details panel scrolls independently
  - Test tab container doesn't scroll when visualization is displayed
  - Test overflow is contained within appropriate components
  - _Requirements: 2.5, 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ]* 11.1 Write unit tests for scroll behavior
  - Test tree view has scrollbar when content exceeds height
  - Test details panel has scrollbar when content exceeds height
  - Test tab container has no scrollbar
  - Test scrolling one panel doesn't affect the other
  - _Requirements: 2.5, 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 12. Verify Info view styling consistency with trace flyout
  - Compare TraceInfoView rendering with TraceFlyoutContent Info tab
  - Verify same card-based layout is used
  - Verify typography, spacing, and colors match
  - Verify metrics display format matches
  - Verify icon and badge styling matches
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ]* 12.1 Write unit tests for Info view styling consistency
  - Test same card components are used
  - Test same layout structure is used
  - Test same typography classes are applied
  - Test same icon components are used
  - Test same badge styles are applied
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

- [ ]* 12.2 Write property test for view mode padding consistency
  - **Property 8: View Mode Padding Consistency**
  - **Validates: Requirements 4.6**

- [x] 13. Final checkpoint - Ensure all tests pass
  - Run all unit tests and verify they pass
  - Run all property-based tests and verify they pass
  - Run all integration tests and verify they pass
  - Manually test the Traces tab in the browser
  - Verify all requirements are met
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional test-related sub-tasks and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties across randomized inputs
- Unit tests validate specific examples and edge cases
- Integration tests validate end-to-end user flows
- All tests should be tagged with feature name and property/requirement references
