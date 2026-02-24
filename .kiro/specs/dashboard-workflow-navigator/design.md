# Design Document: Dashboard Workflow Navigator

## Overview

The Workflow Navigator is a new card component that will be added to the Agent Health Dashboard Overview page. It provides users with quick access to three primary workflows: Debug & Monitor, Test & Validate, and Create Test Cases. The component will be positioned in a 2-column grid layout alongside the existing Performance Trends card, creating a more balanced and functional dashboard layout.

### Goals

- Provide clear, accessible navigation to common workflows from the Overview page
- Enhance user experience with visual feedback and intuitive design
- Maintain consistency with existing design system and component patterns
- Ensure responsive behavior across different screen sizes
- Keep the implementation simple and maintainable

### Non-Goals

- Adding additional workflow options beyond the three specified
- Implementing workflow customization or personalization
- Adding analytics or tracking for workflow navigation
- Creating a modal or multi-step workflow wizard

## Architecture

### Component Hierarchy

```
Dashboard (existing)
├── Header (existing)
├── Loading/Empty State (existing)
└── Content Section (modified)
    ├── Grid Container (new)
    │   ├── WorkflowNavigator (new)
    │   └── PerformanceTrendsCard (existing)
    └── BenchmarkMetricsCard (existing)
```

### Layout Structure

The dashboard layout will be modified to use a responsive grid system:

1. **Large screens (lg breakpoint and above)**: 2-column grid for Workflow Navigator and Performance Trends
2. **Small/medium screens**: Single column stack
3. **Benchmark Metrics**: Always full width below the grid

### Technology Stack

- **React**: Component framework
- **TypeScript**: Type safety
- **react-router-dom**: Navigation (Link component)
- **lucide-react**: Icon library
- **shadcn/ui**: Component library (Card, CardHeader, CardTitle, CardDescription, CardContent)
- **Tailwind CSS**: Styling and responsive design

## Components and Interfaces

### WorkflowNavigator Component

**Location**: `agent-health-jasonlh/components/dashboard/WorkflowNavigator.tsx`

**Purpose**: Renders the Workflow Navigator card with three clickable workflow options.

**Props**: None (stateless component)

**Structure**:

```typescript
export const WorkflowNavigator: React.FC = () => {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Compass className="h-5 w-5" />
          Your Workflow
        </CardTitle>
        <CardDescription>
          Choose your starting point based on your goal
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          {/* Three WorkflowOption components */}
        </div>
      </CardContent>
    </Card>
  );
};
```

### WorkflowOption Sub-Component

**Purpose**: Renders a single clickable workflow option with icon, title, description, and hover effects.

**Props**:

```typescript
interface WorkflowOptionProps {
  to: string;           // Navigation path
  icon: LucideIcon;     // Icon component from lucide-react
  iconColor: string;    // Tailwind color class (e.g., "text-blue-500")
  title: string;        // Option title
  description: string;  // Option description
}
```

**Implementation Pattern**:

```typescript
const WorkflowOption: React.FC<WorkflowOptionProps> = ({
  to,
  icon: Icon,
  iconColor,
  title,
  description,
}) => {
  return (
    <Link
      to={to}
      className="flex items-start gap-3 p-2 rounded-md hover:bg-accent transition-colors group"
    >
      <div className="mt-0.5">
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium group-hover:underline">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
};
```

### Dashboard Component Modifications

**Changes Required**:

1. Import the WorkflowNavigator component
2. Wrap Performance Trends Card and Workflow Navigator in a grid container
3. Conditionally render both cards only when `hasData` is true

**Modified Structure**:

```typescript
{isLoading ? (
  <DashboardSkeleton />
) : !hasData ? (
  <EmptyState />
) : (
  <>
    {/* Grid Container for Workflow Navigator and Performance Trends */}
    <div className="grid gap-8 lg:grid-cols-2">
      <WorkflowNavigator />
      <Card>
        {/* Existing Performance Trends Card content */}
      </Card>
    </div>

    {/* Benchmark Metrics Table - Full Width */}
    <Card>
      {/* Existing Benchmark Metrics Table content */}
    </Card>
  </>
)}
```

## Data Models

### Workflow Configuration

The workflow options are statically defined within the component:

```typescript
const workflows = [
  {
    to: '/agent-traces',
    icon: Activity,
    iconColor: 'text-blue-500',
    title: 'Debug & Monitor',
    description: 'View agent execution traces and debug issues',
  },
  {
    to: '/benchmarks',
    icon: Target,
    iconColor: 'text-green-500',
    title: 'Test & Validate',
    description: 'Run benchmarks and validate agent performance',
  },
  {
    to: '/test-cases',
    icon: FileText,
    iconColor: 'text-purple-500',
    title: 'Create Test Cases',
    description: 'Build and manage test cases for your agents',
  },
];
```

### Type Definitions

```typescript
import { LucideIcon } from 'lucide-react';

interface WorkflowOptionProps {
  to: string;
  icon: LucideIcon;
  iconColor: string;
  title: string;
  description: string;
}
```

No additional state management or data fetching is required for this component.


## Correctness Properties

A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.

### Property 1: Workflow Navigator Conditional Rendering

*For any* Dashboard render, the WorkflowNavigator component should be present in the DOM if and only if `hasData` is true.

**Validates: Requirements 1.1, 1.5, 7.4**

### Property 2: Workflow Navigator Content Structure

*For any* rendered WorkflowNavigator component, it should contain:
- A title "Your Workflow" with a Compass icon
- A description "Choose your starting point based on your goal"
- Exactly three workflow options with titles "Debug & Monitor", "Test & Validate", and "Create Test Cases"

**Validates: Requirements 1.3, 1.4, 2.1**

### Property 3: Workflow Navigation Paths

*For any* rendered WorkflowNavigator component, each workflow option should have the correct navigation path:
- "Debug & Monitor" links to `/agent-traces`
- "Test & Validate" links to `/benchmarks`
- "Create Test Cases" links to `/test-cases`

**Validates: Requirements 2.2, 2.3, 2.4, 7.5**

### Property 4: Workflow Icons and Colors

*For any* rendered WorkflowNavigator component, each workflow option should display the correct icon with the correct color:
- "Debug & Monitor" has Activity icon with blue color (text-blue-500)
- "Test & Validate" has Target icon with green color (text-green-500)
- "Create Test Cases" has FileText icon with purple color (text-purple-500)

**Validates: Requirements 2.5, 2.6, 2.7**

### Property 5: Workflow Descriptions Present

*For any* rendered WorkflowNavigator component, each workflow option should display a description text below its title.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 6: No Modal Dialogs

*For any* rendered Dashboard with WorkflowNavigator, there should be no modal dialog components present in the DOM.

**Validates: Requirements 3.4**

### Property 7: Hover Effect Styling

*For any* workflow option Link element, it should have the following CSS classes for hover effects:
- `hover:bg-accent` for background color change
- `transition-colors` for smooth transitions
- Title element with `group-hover:underline`
- ChevronRight icon with `opacity-0 group-hover:opacity-100 transition-opacity`

**Validates: Requirements 4.1, 4.2, 4.3, 4.4**

### Property 8: Grid Layout Structure

*For any* rendered Dashboard with data, the WorkflowNavigator and Performance Trends Card should be wrapped in a container with:
- `grid` class for grid layout
- `lg:grid-cols-2` class for 2-column layout on large screens
- `gap-8` class for consistent spacing

**Validates: Requirements 1.2, 5.1, 5.4**

### Property 9: Responsive Stacking

*For any* rendered Dashboard with data, the grid container should use Tailwind's mobile-first approach where the default (no lg: prefix) behavior is single column, and `lg:grid-cols-2` applies only at large breakpoints.

**Validates: Requirements 5.2**

### Property 10: Benchmark Metrics Full Width

*For any* rendered Dashboard with data, the Benchmark Metrics Card should be outside the grid container and maintain full width.

**Validates: Requirements 5.3**

### Property 11: Component Library Usage

*For any* rendered WorkflowNavigator component, it should use shadcn/ui components (Card, CardHeader, CardTitle, CardDescription, CardContent) for consistent styling.

**Validates: Requirements 6.1, 6.4**

### Property 12: Icon Size Consistency

*For any* rendered WorkflowNavigator component:
- The card title Compass icon should have `h-5 w-5` classes
- All workflow option icons should have `h-4 w-4` classes

**Validates: Requirements 6.5**

### Property 13: Dashboard Integration

*For any* rendered Dashboard component with data, it should import and render the WorkflowNavigator component.

**Validates: Requirements 7.3**

## Error Handling

### Component Rendering Errors

Since the WorkflowNavigator is a presentational component with no data fetching or state management, error handling is minimal:

1. **Missing Dependencies**: If lucide-react icons or shadcn/ui components are not available, the build will fail at compile time (TypeScript/build error).

2. **Navigation Errors**: Navigation is handled by react-router-dom's Link component, which handles invalid routes gracefully by default.

3. **Conditional Rendering**: The component only renders when `hasData` is true, preventing display in empty states.

### Defensive Practices

1. **Type Safety**: Use TypeScript interfaces for all props to catch type errors at compile time.
2. **CSS Classes**: Use Tailwind's utility classes which are validated at build time.
3. **Static Configuration**: Workflow options are statically defined, eliminating runtime configuration errors.

## Testing Strategy

### Unit Testing

Unit tests will verify specific examples and component behavior:

1. **Component Rendering**:
   - WorkflowNavigator renders with correct structure
   - All three workflow options are present
   - Correct icons and text content are displayed

2. **Conditional Rendering**:
   - WorkflowNavigator appears when hasData is true
   - WorkflowNavigator does not appear when hasData is false

3. **Navigation**:
   - Each workflow option has correct Link 'to' prop
   - Link components are from react-router-dom

4. **Styling**:
   - Correct CSS classes are applied
   - Grid layout structure is correct
   - Icon sizes are consistent

5. **Dashboard Integration**:
   - Dashboard imports and renders WorkflowNavigator
   - Grid container wraps both cards correctly
   - Benchmark Metrics Card remains outside grid

### Property-Based Testing

Property-based tests are not applicable for this feature because:

1. **Static Content**: The component renders static, predefined content (no dynamic inputs to generate)
2. **Presentational Component**: No business logic or data transformations to test with random inputs
3. **UI Structure**: Testing focuses on specific DOM structure and CSS classes, not universal properties across inputs

Instead, comprehensive unit tests with React Testing Library will verify all acceptance criteria through example-based testing.

### Testing Tools

- **React Testing Library**: Component rendering and DOM queries
- **Jest**: Test runner and assertions
- **@testing-library/user-event**: User interaction simulation (hover, click)
- **@testing-library/jest-dom**: Custom matchers for DOM assertions

### Test Coverage Goals

- 100% coverage of WorkflowNavigator component
- Integration tests for Dashboard component modifications
- Visual regression tests for hover states (optional, using Storybook or similar)

### Manual Testing Checklist

1. Verify WorkflowNavigator appears on Dashboard when data exists
2. Verify WorkflowNavigator does not appear in empty state
3. Click each workflow option and verify navigation
4. Test hover effects on each workflow option
5. Test responsive behavior at different screen sizes
6. Verify visual consistency with existing dashboard cards
7. Test keyboard navigation (Tab, Enter)
8. Verify accessibility (screen reader compatibility)
