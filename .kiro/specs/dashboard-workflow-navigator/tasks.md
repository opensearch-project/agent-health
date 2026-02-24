# Implementation Plan: Dashboard Workflow Navigator

## Overview

This implementation adds a Workflow Navigator card to the Dashboard Overview page, providing quick access to three common workflows. The implementation involves creating a new WorkflowNavigator component and modifying the Dashboard component to use a 2-column grid layout.

## Tasks

- [x] 1. Create WorkflowNavigator component structure
  - Create new file `agent-health-jasonlh/components/dashboard/WorkflowNavigator.tsx`
  - Import required dependencies: React, Link from react-router-dom, icons from lucide-react, shadcn/ui Card components
  - Define TypeScript interface for WorkflowOptionProps
  - Set up basic component structure with Card, CardHeader, and CardContent
  - _Requirements: 7.1, 7.2, 6.1, 6.4_

- [ ]* 1.1 Write unit tests for WorkflowNavigator component structure
  - Test that component renders without errors
  - Test that Card components are used correctly
  - _Requirements: 6.1, 6.4_

- [ ] 2. Implement WorkflowOption sub-component
  - [x] 2.1 Create WorkflowOption functional component
    - Accept props: to, icon, iconColor, title, description
    - Implement Link wrapper with flex layout
    - Add icon with proper sizing and color
    - Add title and description text
    - Add ChevronRight icon with opacity transition
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3_

  - [x] 2.2 Add hover effect styling
    - Apply hover:bg-accent class to Link
    - Apply transition-colors for smooth transitions
    - Apply group-hover:underline to title
    - Apply opacity-0 group-hover:opacity-100 to ChevronRight
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 2.3 Write unit tests for WorkflowOption component
    - Test navigation paths are correct
    - Test icons and colors are correct
    - Test hover effect classes are present
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 4.1, 4.2, 4.3, 4.4_

- [x] 3. Implement workflow options configuration
  - Define static workflows array with three options
  - Configure "Debug & Monitor" option (Activity icon, blue, /agent-traces)
  - Configure "Test & Validate" option (Target icon, green, /benchmarks)
  - Configure "Create Test Cases" option (FileText icon, purple, /test-cases)
  - Map workflows array to WorkflowOption components
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3_

- [ ]* 3.1 Write unit tests for workflow configuration
  - Test all three workflow options are rendered
  - Test correct titles, descriptions, and navigation paths
  - Test correct icons and colors for each option
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3_

- [x] 4. Add card header with title and description
  - Add CardTitle with "Your Workflow" text
  - Add Compass icon to title with h-5 w-5 sizing
  - Add CardDescription with "Choose your starting point based on your goal" text
  - Apply proper spacing and layout classes
  - _Requirements: 1.3, 1.4, 6.5_

- [ ]* 4.1 Write unit tests for card header
  - Test title text and Compass icon are present
  - Test description text is present
  - Test icon sizing classes are correct
  - _Requirements: 1.3, 1.4, 6.5_

- [x] 5. Checkpoint - Verify WorkflowNavigator component
  - Ensure WorkflowNavigator component builds without errors
  - Ensure all unit tests pass
  - Ask the user if questions arise

- [x] 6. Modify Dashboard component layout
  - [x] 6.1 Import WorkflowNavigator component in Dashboard.tsx
    - Add import statement for WorkflowNavigator
    - _Requirements: 7.3_

  - [x] 6.2 Create grid container for cards
    - Wrap WorkflowNavigator and Performance Trends Card in a div
    - Apply grid, gap-8, and lg:grid-cols-2 classes to container
    - Place grid container inside the hasData conditional block
    - _Requirements: 1.2, 5.1, 5.2, 5.4_

  - [x] 6.3 Position WorkflowNavigator in grid
    - Place WorkflowNavigator as first child in grid container
    - Ensure Performance Trends Card remains as second child
    - Verify Benchmark Metrics Card stays outside grid (full width)
    - _Requirements: 1.1, 1.2, 5.3, 7.4_

  - [ ]* 6.4 Write integration tests for Dashboard layout
    - Test WorkflowNavigator renders when hasData is true
    - Test WorkflowNavigator does not render when hasData is false
    - Test grid container has correct classes
    - Test Benchmark Metrics Card is outside grid
    - _Requirements: 1.1, 1.5, 1.2, 5.1, 5.3, 5.4, 7.4_

- [x] 7. Verify responsive behavior
  - Test layout at large viewport (2-column grid)
  - Test layout at small/medium viewport (single column stack)
  - Verify gap spacing is consistent
  - Verify Benchmark Metrics Table remains full width at all sizes
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [ ]* 7.1 Write responsive layout tests
  - Test grid has lg:grid-cols-2 class for large screens
  - Test grid stacks on smaller screens (default behavior)
  - _Requirements: 5.1, 5.2_

- [x] 8. Verify visual consistency
  - Compare WorkflowNavigator styling with existing dashboard cards
  - Verify icon sizes are consistent (h-5 w-5 for title, h-4 w-4 for options)
  - Verify color scheme matches existing components
  - Verify spacing and typography match design system
  - _Requirements: 6.1, 6.3, 6.4, 6.5_

- [x] 9. Test accessibility and keyboard navigation
  - Verify all workflow options are keyboard accessible (Tab navigation)
  - Verify Enter key activates navigation
  - Test with screen reader to ensure proper announcements
  - Verify focus indicators are visible
  - _Requirements: 2.2, 2.3, 2.4_

- [x] 10. Final checkpoint - Complete testing and verification
  - Ensure all unit tests pass
  - Ensure integration tests pass
  - Verify no console errors or warnings
  - Test all three navigation paths work correctly
  - Verify hover effects work as expected
  - Ensure responsive behavior is correct
  - Ask the user if questions arise

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The WorkflowNavigator component is stateless and presentational, requiring no data fetching or state management
- All styling uses Tailwind CSS utility classes for consistency
- The implementation maintains the existing Dashboard structure and only adds the new card
- Testing focuses on unit tests and integration tests since property-based testing is not applicable for static UI components
