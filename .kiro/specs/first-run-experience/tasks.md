# Implementation Plan: First Run Experience

## Overview

This implementation plan breaks down the First Run Experience feature into discrete coding tasks. The approach follows an incremental strategy: first implementing data state detection, then the FirstRunExperience component, then integrating it into the Dashboard, and finally adding sample data loading functionality. Each step builds on the previous one and includes testing tasks to validate correctness early.

## Tasks

- [x] 1. Implement data state detection logic
  - [x] 1.1 Create useDataState hook
    - Create `hooks/useDataState.ts` file
    - Implement hook that checks `asyncExperimentStorage.getAll()` and `asyncRunStorage.getAllReports()`
    - Return `{ dataState: DataState, isLoading: boolean }` interface
    - Include error handling with fallback to empty state
    - _Requirements: 2.1, 2.2, 2.3, 7.4_
  
  - [ ]* 1.2 Write property test for data state detection
    - **Property 3: Conditional Dashboard Rendering**
    - **Validates: Requirements 2.1, 2.2, 7.3**
    - Test that for any data state, exactly one dashboard variant is determined
  
  - [ ]* 1.3 Write unit tests for useDataState hook
    - Test empty state (no benchmarks, no reports)
    - Test populated state (benchmarks with runs)
    - Test error handling (storage failures)
    - Test loading state transitions
    - _Requirements: 2.1, 2.2, 2.3_

- [x] 2. Create WorkflowNavigatorFirstRun component
  - [x] 2.1 Extract and adapt WorkflowNavigator for first-run context
    - Create `components/dashboard/WorkflowNavigatorFirstRun.tsx`
    - Copy visual structure from existing WorkflowNavigator
    - Remove localStorage persistence logic
    - Remove "Don't show again" functionality
    - Keep: title, supporting line, three-stage loop, outcome descriptions
    - Adjust CTAs to be exploratory ("Explore Benchmarks", "Explore Traces")
    - _Requirements: 3.4, 5.1, 5.2, 5.3, 5.4, 7.2_
  
  - [ ]* 2.2 Write unit tests for WorkflowNavigatorFirstRun
    - Test component renders with correct title
    - Test supporting line is present
    - Test three workflow stages are displayed in order
    - Test outcome descriptions are present
    - Test CTAs are exploratory (not action-oriented)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 3. Create FirstRunExperience component
  - [x] 3.1 Implement FirstRunExperience component structure
    - Create `components/dashboard/FirstRunExperience.tsx`
    - Add hero section with headline and product explanation
    - Add primary CTA button "View Sample Data"
    - Integrate WorkflowNavigatorFirstRun component
    - Add sample data explanation section
    - Add secondary link "Connect Your Own Data"
    - Apply styling consistent with existing dashboard
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 7.1, 7.2_
  
  - [ ]* 3.2 Write unit tests for FirstRunExperience UI elements
    - Test headline is displayed
    - Test product explanation is present
    - Test "View Sample Data" button exists
    - Test WorkflowNavigatorFirstRun is rendered
    - Test sample data explanation is present
    - Test "Connect Your Own Data" link exists
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Integrate FirstRunExperience into Dashboard component
  - [x] 5.1 Modify Dashboard component for conditional rendering
    - Import useDataState hook and FirstRunExperience component
    - Add data state check at component start
    - Implement conditional rendering: FirstRunExperience when no data, standard dashboard when data exists
    - Ensure loading state shows skeleton
    - Preserve all existing dashboard functionality
    - _Requirements: 1.3, 2.1, 2.2, 2.4, 7.3_
  
  - [ ]* 5.2 Write property test for conditional rendering
    - **Property 3: Conditional Dashboard Rendering**
    - **Validates: Requirements 2.1, 2.2, 7.3**
    - Test that for any data state, exactly one of FirstRunExperience or Standard_Overview renders
  
  - [ ]* 5.3 Write property test for state transitions
    - **Property 4: Data State Transition**
    - **Validates: Requirements 2.4**
    - Test that changing from empty to populated state triggers correct component switch
  
  - [ ]* 5.4 Write unit tests for Dashboard integration
    - Test Dashboard renders FirstRunExperience when no data
    - Test Dashboard renders standard dashboard when data exists
    - Test loading state shows skeleton
    - Test error state defaults to FirstRunExperience
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 6. Implement sample data loading functionality
  - [x] 6.1 Create sample data configuration and loading function
    - Create `config/sampleData.ts` with SAMPLE_DATA_CONFIG constant
    - Define sample cluster ID, name, and description
    - Create `loadSampleData()` function that sets active cluster to sample cluster
    - Add error handling with user-friendly error messages
    - _Requirements: 4.1, 4.4_
  
  - [x] 6.2 Wire sample data loading to FirstRunExperience
    - Import loadSampleData function in FirstRunExperience
    - Connect "View Sample Data" button onClick handler
    - Add navigation to dashboard after successful load
    - Add error toast notification on failure
    - _Requirements: 4.1_
  
  - [ ]* 6.3 Write property test for configuration externalization
    - **Property 5: Sample Data Configuration Externalization**
    - **Validates: Requirements 4.4**
    - Test that sample cluster ID is retrieved from configuration constant
  
  - [ ]* 6.4 Write unit tests for sample data loading
    - Test loadSampleData function calls correct storage methods
    - Test successful load navigates to dashboard
    - Test error handling displays toast notification
    - Test button click triggers loadSampleData
    - _Requirements: 4.1, 4.4_

- [x] 7. Add sample data indicator to dashboard
  - [x] 7.1 Implement sample data mode detection and indicator
    - Add function to detect if current cluster is sample cluster
    - Add badge/banner to dashboard header when in sample mode
    - Display message: "You're viewing sample data"
    - Add link to "Connect Your Own Data" in indicator
    - _Requirements: 4.5_
  
  - [ ]* 7.2 Write unit tests for sample data indicator
    - Test indicator displays when sample cluster is active
    - Test indicator hidden when real data is active
    - Test "Connect Your Own Data" link is present in indicator
    - _Requirements: 4.5_

- [x] 8. Verify navigation consistency
  - [x] 8.1 Test navigation structure across data states
    - Manually verify left navigation is identical in both states
    - Verify navigation order and hierarchy unchanged
    - Verify non-Overview pages (Traces, Benchmarks) unchanged
    - Document any inconsistencies found
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  
  - [ ]* 8.2 Write property tests for navigation consistency
    - **Property 1: Navigation Consistency Across Data States**
    - **Validates: Requirements 1.1, 1.2**
    - Test navigation structure is identical for any data state
  
  - [ ]* 8.3 Write property test for non-Overview page invariance
    - **Property 2: Non-Overview Page Invariance**
    - **Validates: Requirements 1.3, 1.4**
    - Test non-Overview pages are identical regardless of data state

- [x] 9. Final checkpoint - Ensure all tests pass and integration works
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Property tests validate universal correctness properties across all inputs
- Unit tests validate specific examples, UI elements, and error conditions
- The implementation follows an incremental approach: data detection → components → integration → sample data
- All TypeScript interfaces and types are defined in the design document
- Existing WorkflowNavigator component is reused with modifications for first-run context
