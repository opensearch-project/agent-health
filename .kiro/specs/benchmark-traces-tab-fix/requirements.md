# Requirements Document

## Introduction

The Benchmark page (RunDetailsPage.tsx) displays evaluation reports for agent test runs. It includes a "Traces" tab that shows trace visualization for trace-mode agents. Currently, the Traces tab has layout and display issues that prevent proper visualization of trace data. This feature addresses these issues to provide a consistent, functional trace viewing experience within benchmark reports.

## Glossary

- **Benchmark_Page**: The RunDetailsPage component that displays detailed evaluation reports for agent test runs
- **Traces_Tab**: The tab within RunDetailsContent that displays trace visualization or OpenSearch logs
- **TraceVisualization_Component**: The shared component that renders trace data in multiple view modes (timeline, tree, flow, agent-map, stats, info)
- **Span_Tree**: A hierarchical structure of trace spans representing the execution flow of an agent
- **View_Mode**: The display format for traces (timeline, tree, gantt, flow, agent-map, stats, info)
- **Details_Panel**: The side panel that shows detailed information about a selected span
- **Fullscreen_View**: A modal dialog that displays traces in fullscreen mode
- **Run_Report**: An evaluation report containing test execution data, metrics, and trace information

## Requirements

### Requirement 1: Trace Tab Container Layout

**User Story:** As a developer reviewing benchmark results, I want the Traces tab to properly contain and display trace visualizations, so that I can analyze agent execution without layout issues.

#### Acceptance Criteria

1. WHEN the Traces tab is selected THEN the System SHALL display the trace visualization within the available tab content area
2. WHEN trace data is loaded THEN the System SHALL ensure the TraceVisualization component fills the available height without overflow
3. WHEN the browser window is resized THEN the System SHALL maintain proper trace visualization layout and scrolling behavior
4. WHEN switching between tabs THEN the System SHALL preserve the trace visualization state and view mode
5. WHEN the trace visualization includes a details panel THEN the System SHALL ensure both the tree view and details panel are visible without horizontal scrolling

### Requirement 2: Trace Visualization Height Management

**User Story:** As a developer analyzing traces, I want the trace visualization to use the full available height, so that I can see as much trace data as possible without unnecessary scrolling.

#### Acceptance Criteria

1. THE Traces_Tab_Container SHALL use flexbox layout to allocate available vertical space to the trace visualization
2. WHEN the TraceVisualization component is rendered THEN the System SHALL apply appropriate height constraints to prevent content overflow
3. WHEN the view mode is changed THEN the System SHALL maintain consistent height allocation across all view modes
4. WHEN the details panel is collapsed or expanded THEN the System SHALL adjust the layout without affecting the overall container height
5. THE System SHALL ensure scrolling occurs within the trace visualization component, not at the tab level

### Requirement 3: Details Panel Integration

**User Story:** As a developer examining trace details, I want the span details panel to display correctly alongside the trace tree, so that I can view span information without layout issues.

#### Acceptance Criteria

1. WHEN a span is selected THEN the System SHALL display the details panel on the right side of the trace tree
2. WHEN the details panel is visible THEN the System SHALL allocate appropriate width to both the tree view and details panel
3. WHEN the details panel is collapsed THEN the System SHALL expand the tree view to use the full available width
4. WHEN the resizable divider is dragged THEN the System SHALL update the width allocation between tree view and details panel
5. THE System SHALL ensure the details panel remains visible and scrollable when displaying long span content

### Requirement 4: View Mode Consistency and Default Selection

**User Story:** As a developer switching between trace views, I want all view modes to display correctly within the Traces tab with a sensible default view, so that I can choose the most appropriate visualization for my analysis.

#### Acceptance Criteria

1. WHEN the Traces tab is first opened THEN the System SHALL display the info view mode by default
2. WHEN the timeline view mode is selected THEN the System SHALL display the trace tree table with proper layout
3. WHEN the gantt view mode is selected THEN the System SHALL display the timeline chart with proper layout
4. WHEN the agent-map view mode is selected THEN the System SHALL display the agent map with proper layout
5. WHEN the stats or info view modes are selected THEN the System SHALL display the respective views with proper layout
6. THE System SHALL maintain consistent padding and spacing across all view modes
7. THE System SHALL provide view mode options in the order: Info, Trace Tree, Agent Map, Timeline

### Requirement 5: Fullscreen Trace View

**User Story:** As a developer needing detailed trace analysis, I want to open traces in fullscreen mode from the Traces tab, so that I can examine complex traces with maximum screen space.

#### Acceptance Criteria

1. WHEN the fullscreen button is clicked THEN the System SHALL open the TraceFullScreenView dialog
2. WHEN the fullscreen view is opened THEN the System SHALL preserve the current view mode and selected span
3. WHEN the fullscreen view is closed THEN the System SHALL restore the Traces tab state including view mode and selected span
4. WHEN in fullscreen mode THEN the System SHALL provide the same view mode options as the embedded view
5. THE System SHALL ensure the fullscreen view uses the full viewport height and width

### Requirement 6: Loading and Error States

**User Story:** As a developer waiting for traces to load, I want clear feedback about the loading status, so that I understand when trace data will be available.

#### Acceptance Criteria

1. WHEN traces are being fetched THEN the System SHALL display a loading indicator with appropriate messaging
2. WHEN traces fail to load THEN the System SHALL display an error message with details about the failure
3. WHEN traces are pending (not yet available) THEN the System SHALL display a pending state message explaining the delay
4. WHEN no run ID is available THEN the System SHALL display a message indicating traces cannot be loaded
5. WHEN traces are successfully loaded THEN the System SHALL remove loading indicators and display the trace visualization

### Requirement 7: Trace Tab Activation Behavior

**User Story:** As a developer navigating to the Traces tab, I want traces to load automatically when needed, so that I don't have to manually trigger the fetch.

#### Acceptance Criteria

1. WHEN the Traces tab is clicked for the first time THEN the System SHALL automatically fetch traces if a run ID is available
2. WHEN switching between different benchmark reports THEN the System SHALL reset the trace state and fetch new traces when the Traces tab is active
3. WHEN traces have already been fetched THEN the System SHALL not re-fetch traces on subsequent tab activations
4. WHEN the report status is pending THEN the System SHALL display the pending state without attempting to fetch traces
5. THE System SHALL provide a manual "Load Traces" button when traces have not been fetched and the report is ready

### Requirement 8: Responsive Layout Behavior

**User Story:** As a developer using different screen sizes, I want the Traces tab to adapt to available space, so that I can view traces effectively on various displays.

#### Acceptance Criteria

1. WHEN the viewport width is reduced THEN the System SHALL maintain readable trace visualization without breaking layout
2. WHEN the details panel is visible on small screens THEN the System SHALL ensure both panels remain accessible
3. WHEN the resizable divider is used THEN the System SHALL constrain width percentages to maintain usability
4. THE System SHALL use appropriate minimum widths for the tree view and details panel
5. THE System SHALL ensure text and UI elements remain readable at different viewport sizes

### Requirement 9: State Synchronization

**User Story:** As a developer interacting with traces, I want my selections and view preferences to be preserved, so that I can maintain context while analyzing traces.

#### Acceptance Criteria

1. WHEN a span is selected in the embedded view THEN the System SHALL maintain that selection when switching to fullscreen
2. WHEN the view mode is changed in the embedded view THEN the System SHALL preserve that mode when switching to fullscreen
3. WHEN expanded spans are toggled THEN the System SHALL maintain the expansion state across view mode changes
4. WHEN returning from fullscreen to embedded view THEN the System SHALL restore the previous state
5. THE System SHALL synchronize selected span and view mode between the Traces tab and fullscreen view

### Requirement 10: Scroll Behavior

**User Story:** As a developer examining large traces, I want scrolling to work intuitively, so that I can navigate through trace data efficiently.

#### Acceptance Criteria

1. WHEN the trace tree exceeds the visible area THEN the System SHALL provide vertical scrolling within the tree container
2. WHEN the details panel content exceeds the visible area THEN the System SHALL provide vertical scrolling within the details panel
3. WHEN scrolling the tree view THEN the System SHALL not scroll the details panel
4. WHEN scrolling the details panel THEN the System SHALL not scroll the tree view
5. THE System SHALL ensure the tab container itself does not scroll when trace visualization is displayed

### Requirement 11: Info View Styling Consistency

**User Story:** As a developer viewing trace information, I want the info tab styling to match the trace flyout design, so that I have a consistent visual experience across the application.

#### Acceptance Criteria

1. WHEN the info view mode is displayed THEN the System SHALL use the same layout and styling as the trace flyout info view
2. THE System SHALL display trace metadata using the same card-based layout as the trace flyout
3. THE System SHALL use consistent typography, spacing, and color schemes between the Traces tab info view and the trace flyout info view
4. THE System SHALL display metrics and statistics using the same visual format as the trace flyout
5. THE System SHALL ensure icon usage and badge styling match the trace flyout design
